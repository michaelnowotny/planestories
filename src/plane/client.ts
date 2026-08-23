import { PlaneApiError } from "../errors.ts";
import { Pacer, type PacerOptions } from "./pacer.ts";
import { normalizeRelations } from "./relation_refs.ts";

export const DEFAULT_PLANE_BASE_URL = "https://api.plane.so";

/** Default number of retry attempts for transient failures (on top of the initial try). */
export const DEFAULT_MAX_RETRIES = 5;
/** Default base backoff delay in ms; doubles per attempt and gains jitter. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** Upper bound on any single backoff delay, so a large Retry-After or high attempt can't stall forever. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export interface PlaneClientOptions {
	apiKey: string;
	workspaceSlug: string;
	/** API base URL. Defaults to Plane Cloud (https://api.plane.so). */
	baseUrl?: string;
	/**
	 * Number of retries for transient failures (HTTP 429, 5xx, network errors)
	 * on top of the initial attempt. Default 5. Set 0 to disable retries.
	 */
	maxRetries?: number;
	/** Base backoff delay in ms (default 500). */
	retryBaseDelayMs?: number;
	/** Cap on any single backoff delay in ms (default 30000). */
	maxRetryDelayMs?: number;
	/** Injectable sleep, so tests can run without real delays. */
	sleep?: (ms: number) => Promise<void>;
	/** Work-item REST path family. Default "issues" (see PlaneEndpointDialect). */
	dialect?: PlaneEndpointDialect;
	/** INTERNAL: whether dialect came from explicit user configuration. */
	dialectConfigured?: boolean;
	/**
	 * Invoked before EVERY HTTP attempt of a non-GET request — including each
	 * internal retry after backoff, which a caller-side wrapper cannot see. A
	 * throw aborts the request. Replication wires this to its journal-lock
	 * ownership check so a process that lost its lock during a retry sleep
	 * cannot land further writes.
	 */
	beforeWriteAttempt?: () => void;
	/** Configured per-key API throughput. Omit to preserve legacy unpaced behavior. */
	requestsPerMinute?: number;
	/** Fraction of the configured rate available to this client (default 0.8). */
	rateHeadroom?: number;
	/** Safety cap for Little's-Law-derived concurrency (default 16). */
	maxConcurrency?: number;
	/** INTERNAL: an existing pacer to share (sibling clients on the same API key). */
	pacer?: Pacer;
	/** Injectable clock used by pacing and telemetry. */
	now?: () => number;
}

export type PlaneDependencyRelationType = "blocked_by" | "blocking" | "relates_to";

/**
 * Every relation kind Plane's data model carries. The dependency subset above is
 * what the story-file sync understands; replication moves ALL kinds a target
 * dialect accepts (probe-gated).
 */
export type PlaneRelationKind =
	| "blocked_by"
	| "blocking"
	| "relates_to"
	| "duplicate"
	| "start_before"
	| "start_after"
	| "finish_before"
	| "finish_after";

/**
 * Which REST path family a Plane instance serves work items under. The `/issues/`
 * family is past its announced deprecation but still serves on current cloud and
 * CE; `/work-items/` is its successor. The probe selects per instance; `issues`
 * stays the default because the whole tool is proven against it.
 */
export type PlaneEndpointDialect = "issues" | "work-items";

export interface PlaneIssueRelations {
	blocking: string[];
	blocked_by: string[];
	relates_to: string[];
	duplicate: string[];
	start_before: string[];
	start_after: string[];
	finish_before: string[];
	finish_after: string[];
}

interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	/** When true, a 404 response resolves to null instead of throwing. */
	allowNotFound?: boolean;
	/**
	 * Per-call retry budget override. Use 0 for NON-IDEMPOTENT writes whose
	 * blind replay could duplicate server state (e.g. comment creation): the
	 * transient failure surfaces immediately so the caller can verify durable
	 * state before deciding to retry (the A10 discipline).
	 */
	maxRetries?: number;
}

/** A single page of a cursor-paginated Plane list response. */
interface PlanePage<T> {
	results: T[];
	next_cursor?: string | null;
	next_page_results?: boolean;
}

/**
 * Thin REST client for the Plane API. Uses the native `fetch` (available in Bun)
 * instead of an SDK, so the only auth surface is the `X-API-Key` header.
 *
 * The Plane web app lives on a different host than the API on Cloud
 * (api.plane.so vs app.plane.so); `webBaseUrl` derives the browser URL used
 * for write-back links.
 *
 * Every request is wrapped in transient-failure retry: HTTP 429 (honoring
 * `Retry-After`), 5xx, and network errors are retried with exponential backoff
 * plus jitter up to `maxRetries` times before the error surfaces. This protects
 * bulk imports/grooms from the rate limits that motivated this behavior.
 */
export class PlaneClient {
	readonly apiKey: string;
	readonly workspaceSlug: string;
	readonly baseUrl: string;
	readonly webBaseUrl: string;
	readonly maxRetries: number;
	readonly retryBaseDelayMs: number;
	readonly maxRetryDelayMs: number;
	readonly dialect: PlaneEndpointDialect;
	readonly dialectConfigured: boolean;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly beforeWriteAttempt?: () => void;
	private readonly options: PlaneClientOptions;
	private readonly pacer?: Pacer;
	private readonly now: () => number;
	private requestCount = 0;
	private readonly startedAt: number;

	constructor(options: PlaneClientOptions) {
		this.options = options;
		this.apiKey = options.apiKey;
		this.workspaceSlug = options.workspaceSlug;
		this.baseUrl = (options.baseUrl ?? DEFAULT_PLANE_BASE_URL).replace(/\/+$/, "");
		this.webBaseUrl = deriveWebBaseUrl(this.baseUrl);
		this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
		this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
		this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
		this.dialect = options.dialect ?? "issues";
		this.dialectConfigured = options.dialectConfigured ?? options.dialect !== undefined;
		this.sleep = options.sleep ?? defaultSleep;
		this.beforeWriteAttempt = options.beforeWriteAttempt;
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		// A sibling client (withDialect / withBeforeWriteAttempt) inherits the
		// SAME Pacer: the rate limit is per API key, so two buckets against one
		// key would double the burst whenever both are used concurrently.
		if (options.pacer !== undefined) {
			this.pacer = options.pacer;
		} else if (options.requestsPerMinute !== undefined) {
			const pacerOptions: PacerOptions = {
				requestsPerMinute: options.requestsPerMinute,
				headroom: options.rateHeadroom,
				maxConcurrency: options.maxConcurrency,
				now: this.now,
				sleep: this.sleep,
			};
			this.pacer = new Pacer(pacerOptions);
		}
	}

	/** Requests worth running in parallel, or undefined when pacing is not configured. */
	concurrency(): number | undefined {
		return this.pacer?.concurrency();
	}

	/** One-line completion telemetry for commands which perform paced sweeps. */
	pacingSummary(): string | undefined {
		if (!this.pacer) return undefined;
		const stats = this.pacer.stats();
		const headroom = this.options.rateHeadroom ?? 0.8;
		const configured = this.options.requestsPerMinute as number;
		const reqPerSecond = stats.effectiveRpm / 60;
		const elapsedSeconds = Math.max(0, (this.now() - this.startedAt) / 1000);
		const elapsed = formatDuration(elapsedSeconds);
		const throttled = stats.throttled > 0 ? ` · ${stats.throttled} throttled` : "";
		return `paced: ${configured}/min × ${headroom} → ${reqPerSecond.toFixed(1)} req/s · concurrency ${stats.concurrency} · ${this.requestCount.toLocaleString("en-US")} requests · ${elapsed}${throttled}`;
	}

	/** A sibling client whose every non-GET HTTP attempt first runs `hook`. */
	withBeforeWriteAttempt(hook: () => void): PlaneClient {
		return new PlaneClient({ ...this.options, beforeWriteAttempt: hook, pacer: this.pacer });
	}

	/** A sibling client for another endpoint dialect, retaining this instance's rate profile. */
	withDialect(dialect: PlaneEndpointDialect): PlaneClient {
		return new PlaneClient({
			...this.options,
			dialect,
			dialectConfigured: this.dialectConfigured,
			pacer: this.pacer,
		});
	}

	/** The work-item API path segment for this instance's endpoint dialect. */
	get itemsSegment(): string {
		return this.dialect === "work-items" ? "work-items" : "issues";
	}

	/** Absolute browser URL for a work item, used in markdown write-back. */
	workItemWebUrl(projectId: string, workItemId: string): string {
		return `${this.webBaseUrl}/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}`;
	}

	/** Absolute browser URL for a project's work-items board. */
	projectBoardUrl(projectId: string): string {
		return `${this.webBaseUrl}/${this.workspaceSlug}/projects/${projectId}/issues/`;
	}

	private workspacePath(suffix: string): string {
		return `/api/v1/workspaces/${this.workspaceSlug}${suffix}`;
	}

	/** Exponential backoff with jitter for a given (1-based) attempt number. */
	private backoffDelay(attempt: number): number {
		const exp = this.retryBaseDelayMs * 2 ** (attempt - 1);
		const jitter = Math.random() * this.retryBaseDelayMs;
		return Math.min(exp + jitter, this.maxRetryDelayMs);
	}

	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		if (options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				if (value !== undefined) {
					url.searchParams.set(key, String(value));
				}
			}
		}

		const init: RequestInit = {
			method,
			headers: {
				"X-API-Key": this.apiKey,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
		};

		// attempt is 1-based; we allow up to the retry budget after the first try.
		// A per-call override (options.maxRetries) beats the client default.
		const retryBudget = options.maxRetries ?? this.maxRetries;
		let attempt = 0;
		while (true) {
			attempt++;
			await this.pacer?.acquire();
			// Per-ATTEMPT write hook: a caller-side guard only sees the method
			// call, not the retries after backoff sleeps inside this loop.
			if (this.beforeWriteAttempt && method !== "GET") {
				this.beforeWriteAttempt();
			}

			let response: Response;
			const requestStartedAt = this.now();
			try {
				this.requestCount++;
				response = await fetch(url.toString(), init);
			} catch (error) {
				this.pacer?.recordLatency(this.now() - requestStartedAt);
				// Network-level failure: retry (transient) until the budget is spent.
				if (attempt <= retryBudget) {
					await this.sleep(this.backoffDelay(attempt));
					continue;
				}
				throw new PlaneApiError(
					`Network error calling Plane API (${method} ${path}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			this.pacer?.recordLatency(this.now() - requestStartedAt);
			if (response.status === 429) {
				this.pacer?.recordThrottled();
			}

			if (response.status === 404 && options.allowNotFound) {
				return null as T;
			}

			// Transient HTTP failures (rate limit / server errors): honor Retry-After
			// when present, else exponential backoff, until the retry budget is spent.
			if (isRetryableStatus(response.status) && attempt <= retryBudget) {
				const delay =
					parseRetryAfterMs(response, this.maxRetryDelayMs) ?? this.backoffDelay(attempt);
				await this.sleep(delay);
				continue;
			}

			if (!response.ok) {
				const detail = await safeErrorDetail(response);
				throw new PlaneApiError(
					`Plane API ${method} ${path} failed (${response.status} ${response.statusText})${
						detail ? `: ${detail}` : ""
					}`,
					response.status,
					parseRetryAfterMs(response, this.maxRetryDelayMs) ?? undefined,
				);
			}

			if (response.status === 204) {
				return undefined as T;
			}

			try {
				return (await response.json()) as T;
			} catch {
				return undefined as T;
			}
		}
	}

	/** Fetch every page of a cursor-paginated list endpoint. */
	async listAll<T>(suffix: string, query: RequestOptions["query"] = {}): Promise<T[]> {
		const path = this.workspacePath(suffix);
		const all: T[] = [];
		let cursor: string | undefined;

		do {
			const page = await this.request<PlanePage<T> | T[]>("GET", path, {
				query: { per_page: 100, cursor, ...query },
			});

			// Some endpoints return a bare array, others a paginated envelope.
			if (Array.isArray(page)) {
				all.push(...page);
				cursor = undefined;
			} else {
				all.push(...(page.results ?? []));
				cursor = page.next_page_results ? (page.next_cursor ?? undefined) : undefined;
			}
		} while (cursor);

		return all;
	}

	// --- Resource helpers (paths relative to the workspace) ---

	listProjects<T>(): Promise<T[]> {
		return this.listAll<T>("/projects/");
	}

	/** Instance identity/version, outside the workspace-scoped API. */
	getInstance<T>(): Promise<T> {
		return this.request<T>("GET", "/api/instances/");
	}

	/** The user who owns the API key used by this client. */
	getCurrentUser<T>(): Promise<T> {
		return this.request<T>("GET", "/api/v1/users/me/");
	}

	listStates<T>(projectId: string): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/states/`);
	}

	listLabels<T>(projectId: string): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/labels/`);
	}

	createLabel<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>("POST", this.workspacePath(`/projects/${projectId}/labels/`), { body });
	}

	listProjectMembers<T>(projectId: string): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/members/`);
	}

	listWorkspaceMembers<T>(): Promise<T[]> {
		return this.listAll<T>("/members/");
	}

	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/comments/`);
	}

	/**
	 * One work item's activity trail (who changed what, when). Served under BOTH
	 * dialect spellings on current Plane, so unlike the archived-items list this
	 * one correctly follows `itemsSegment` — the archived-path trap in
	 * docs/HANDOFF.md §9.5b #8 is why that distinction is worth stating rather
	 * than leaving the next reader to assume one rule covers both.
	 */
	listWorkItemActivities<T>(projectId: string, workItemId: string): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/activities/`);
	}

	createWorkItemComment<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T> {
		return this.request<T>(
			"POST",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/comments/`),
			{ body, maxRetries: opts?.maxRetries },
		);
	}

	createWorkItem<T>(
		projectId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T> {
		return this.request<T>(
			"POST",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/`),
			{ body, maxRetries: opts?.maxRetries },
		);
	}

	updateWorkItem<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
	): Promise<T> {
		return this.request<T>(
			"PATCH",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/`),
			{ body },
		);
	}

	listWorkItems<T>(projectId: string, query: RequestOptions["query"] = {}): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/${this.itemsSegment}/`, query);
	}

	/** One bounded page used to obtain a relation-probe item without a board sweep. */
	async sampleWorkItem<T>(projectId: string): Promise<T | null> {
		const page = await this.request<PlanePage<T> | T[]>(
			"GET",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/`),
			{ query: { per_page: 1 } },
		);
		if (Array.isArray(page)) return page[0] ?? null;
		if (!page || !Array.isArray(page.results)) {
			throw new PlaneApiError("Plane work-item sample returned an invalid response envelope");
		}
		return page.results[0] ?? null;
	}

	/** Read-only PQL availability probe using the measured, valid expression. */
	async probePql(projectId: string): Promise<void> {
		await this.request<unknown>(
			"GET",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/`),
			{ query: { per_page: 1, pql: "stateGroup IN openStates()" } },
		);
	}

	/** Read-only workspace count-endpoint availability probe. */
	async probeWorkspaceCount(): Promise<void> {
		await this.request<unknown>("GET", this.workspacePath("/work-items/count/"));
	}

	/**
	 * ONE request that answers "how many items, and what is the highest sequence?".
	 * Plane's paginated envelope already carries `total_count`, so a `per_page=1`
	 * page ordered by descending sequence yields both — the cheap freshness signal
	 * that a rate-limited instance can still afford when a full enumeration cannot
	 * be paid for. Returns null when the envelope does not carry a usable count,
	 * so callers can fail closed instead of inventing one.
	 */
	async workItemCensus(
		projectId: string,
	): Promise<{ totalCount: number; maxSequenceId: number | null } | null> {
		const page = await this.request<{
			total_count?: number;
			count?: number;
			total_results?: number;
			results?: Array<{ sequence_id?: number }>;
		}>("GET", this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/`), {
			query: { per_page: 1, order_by: "-sequence_id" },
		});
		const totalCount = page.total_count ?? page.total_results ?? page.count;
		if (typeof totalCount !== "number") return null;
		const top = page.results?.[0]?.sequence_id;
		return { totalCount, maxSequenceId: typeof top === "number" ? top : null };
	}

	/** Retrieve a single work item (e.g. to read its current labels before merging). */
	getWorkItem<T>(projectId: string, workItemId: string): Promise<T> {
		return this.request<T>(
			"GET",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/`),
		);
	}

	/**
	 * One work item's relations, with every reference normalized to a bare id.
	 *
	 * The normalization is HERE, not in each caller, because the wire shape varies
	 * by dialect (`/issues/` yields strings, `/work-items/` yields
	 * `{project_id, issue_id}` objects) and a caller that forgets sees zero
	 * existing relations rather than an error. See src/plane/relation_refs.ts for
	 * what that cost us.
	 */
	async getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations> {
		try {
			const raw = await this.request<unknown>(
				"GET",
				this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/relations/`),
			);
			return normalizeRelations(raw);
		} catch (error) {
			throw withDialectHint(error, this.dialect);
		}
	}

	createRelation(
		projectId: string,
		workItemId: string,
		relationType: PlaneRelationKind,
		issues: string[],
	): Promise<void> {
		return this.request<void>(
			"POST",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/relations/`),
			{ body: { relation_type: relationType, issues } },
		).catch((error) => {
			throw withDialectHint(error, this.dialect);
		});
	}

	removeRelation(
		projectId: string,
		workItemId: string,
		relationType: PlaneRelationKind,
		relatedIssue: string,
	): Promise<void> {
		return this.request<void>(
			"POST",
			this.workspacePath(
				`/projects/${projectId}/${this.itemsSegment}/${workItemId}/relations/remove/`,
			),
			{ body: { relation_type: relationType, related_issue: relatedIssue } },
		);
	}

	/** Permanently delete a work item (204 on success). */
	deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
		return this.request<void>(
			"DELETE",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/`),
		);
	}

	/**
	 * Look up a work item by external id. Plane treats this as a single-object
	 * lookup: it returns the work item on a match and a 404 when none exists, so
	 * the response is NOT a paginated list. Returns null when not found.
	 */
	findWorkItemByExternalId<T>(
		projectId: string,
		externalId: string,
		externalSource: string,
	): Promise<T | null> {
		return this.request<T | null>(
			"GET",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/`),
			{
				query: { external_id: externalId, external_source: externalSource },
				allowNotFound: true,
			},
		);
	}

	// --- Project / state / label / archive surface (replication) ---

	getProject<T>(projectId: string): Promise<T> {
		return this.request<T>("GET", this.workspacePath(`/projects/${projectId}/`));
	}

	createProject<T>(body: Record<string, unknown>, opts?: { maxRetries?: number }): Promise<T> {
		return this.request<T>("POST", this.workspacePath("/projects/"), {
			body,
			maxRetries: opts?.maxRetries,
		});
	}

	updateProject<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>("PATCH", this.workspacePath(`/projects/${projectId}/`), { body });
	}

	/** Permanently delete a project and everything in it (204 on success). */
	deleteProject(projectId: string): Promise<void> {
		return this.request<void>("DELETE", this.workspacePath(`/projects/${projectId}/`));
	}

	createState<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>("POST", this.workspacePath(`/projects/${projectId}/states/`), { body });
	}

	updateState<T>(projectId: string, stateId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>(
			"PATCH",
			this.workspacePath(`/projects/${projectId}/states/${stateId}/`),
			{ body },
		);
	}

	updateLabel<T>(projectId: string, labelId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>(
			"PATCH",
			this.workspacePath(`/projects/${projectId}/labels/${labelId}/`),
			{ body },
		);
	}

	/**
	 * List a project's ARCHIVED work items. Availability varies by instance
	 * version; returns null when the endpoint does not exist (404), so callers
	 * can record "archived inventory unavailable" instead of failing.
	 */
	async listArchivedWorkItems<T>(projectId: string): Promise<T[] | null> {
		// Plane serves the archived list ONLY under the `work-items` spelling, on the
		// instances that have it at all — measured 2026-08-17: cloud answers
		// `archived-work-items/` with 200 and 404s `archived-issues/`. Deriving this
		// path from the ITEMS dialect therefore made an `issues`-dialect source report
		// "archived endpoint unavailable" when a definitive "nothing archived" was
		// available, and left `verify` carrying a caveat it did not need. Try the
		// canonical spelling first, then the dialect one, and only then conclude.
		const candidates = ["work-items", this.itemsSegment].filter(
			(segment, index, all) => all.indexOf(segment) === index,
		);
		for (const segment of candidates) {
			const path = `/projects/${projectId}/archived-${segment}/`;
			const probe = await this.request<PlanePage<T> | T[] | null>("GET", this.workspacePath(path), {
				query: { per_page: 100 },
				allowNotFound: true,
			});
			if (probe !== null) {
				return this.listAll<T>(path);
			}
		}
		return null;
	}

	/** Archive a work item (availability varies by instance version). */
	archiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		return this.request<void>(
			"POST",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/archive/`),
		);
	}

	/** Restore an archived work item. */
	unarchiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		return this.request<void>(
			"DELETE",
			this.workspacePath(`/projects/${projectId}/${this.itemsSegment}/${workItemId}/archive/`),
		);
	}
}

export function createPlaneClient(options: PlaneClientOptions): PlaneClient {
	return new PlaneClient(options);
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.floor(totalSeconds % 60);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

/**
 * Derive the browser/web base URL from the API base URL.
 * Plane Cloud serves the API at api.plane.so and the app at app.plane.so;
 * self-hosted instances typically serve both from the same origin.
 */
export function deriveWebBaseUrl(apiBaseUrl: string): string {
	try {
		const url = new URL(apiBaseUrl);
		if (url.hostname === "api.plane.so") {
			return "https://app.plane.so";
		}
		// Self-hosted: the web app is served from the instance origin.
		return url.origin;
	} catch {
		return apiBaseUrl;
	}
}

/**
 * Turn a relation-endpoint 404 into an answer instead of a puzzle.
 *
 * Plane serves work items under TWO endpoint families — CE uses `/work-items/`,
 * Plane Cloud uses `/issues/` — and the relation sub-resource 404s if you ask
 * the wrong one. The bare error ("GET …/issues/<uuid>/relations/ 404") reads as
 * "this deployment has no relation API", and two separate sessions independently
 * reached that conclusion, one of them concluding the tool was newer than the
 * server. Both then designed around a feature that was working the whole time.
 *
 * Only fires on 404 from a relation call, and only says what the dialect could
 * be instead — it never retries or switches automatically, because silently
 * talking to a different endpoint family than configured is its own bug.
 */
function withDialectHint(error: unknown, dialect: PlaneEndpointDialect): unknown {
	if (!(error instanceof PlaneApiError) || error.status !== 404) return error;
	const other = dialect === "work-items" ? "issues" : "work-items";
	return new PlaneApiError(
		`${error.message}\n  hint: the relation endpoint 404s when the endpoint DIALECT does not match ` +
			`the deployment. This client is using "${dialect}"; try "${other}" ` +
			`(config: "dialect": "${other}", or PLANE_CTX_<NAME>_DIALECT=${other}). ` +
			"Self-hosted Plane (CE) generally serves work-items; Plane Cloud serves issues.",
		error.status,
	);
}

/**
 * HTTP statuses worth retrying: rate limiting (429) and transient server errors
 * (5xx). THE definition — `isTransientPlaneError` below is its error-shaped
 * sibling, and nothing should spell this policy out a fourth time.
 *
 * House rule: retry only classified-transient failures. That is only meaningful
 * if "classified" means one classification; three copies of the rule is three
 * chances for one path to start retrying something the others treat as
 * permanent.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status < 600);
}

/**
 * The error-shaped form of the same policy. `status === undefined` is a network
 * failure (no response), which is transient by definition.
 *
 * Consolidated from three implementations: this one, `plane/issues.ts`, and
 * `replicate/create.ts`. The two removed were semantically identical to each
 * other and differed from `isRetryableStatus` only in leaving 5xx unbounded.
 */
export function isTransientPlaneError(error: unknown): error is PlaneApiError {
	return (
		error instanceof PlaneApiError &&
		(error.status === undefined || isRetryableStatus(error.status))
	);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the delta-seconds
 * form ("120") and the HTTP-date form. Returns undefined when absent/unparseable,
 * and clamps the result to [0, maxDelayMs].
 */
function parseRetryAfterMs(response: Response, maxDelayMs: number): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) {
		return undefined;
	}
	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return clampDelay(seconds * 1000, maxDelayMs);
	}
	const dateMs = Date.parse(header);
	if (!Number.isNaN(dateMs)) {
		return clampDelay(dateMs - Date.now(), maxDelayMs);
	}
	return undefined;
}

function clampDelay(ms: number, maxDelayMs: number): number {
	return Math.min(Math.max(0, ms), maxDelayMs);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeErrorDetail(response: Response): Promise<string | undefined> {
	try {
		const text = await response.text();
		if (!text) {
			return undefined;
		}
		// Surface the most useful field from a JSON error body when present.
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const message = parsed.error ?? parsed.error_message ?? parsed.detail ?? parsed.message;
			return message ? String(message) : text.slice(0, 500);
		} catch {
			return text.slice(0, 500);
		}
	} catch {
		return undefined;
	}
}
