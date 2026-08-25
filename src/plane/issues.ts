import { PlaneApiError } from "../errors.ts";
import { htmlToMarkdown, markdownToHtml } from "../markdown/html.ts";
import type { PlanePriority } from "../types.ts";
import { isTransientPlaneError, type PlaneClient } from "./client.ts";

export interface CreateWorkItemInput {
	name: string;
	/** Raw markdown body; converted to HTML for Plane's description_html. */
	body?: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: PlanePriority;
	/** Story points -> Plane's `point` field. */
	estimate?: number;
	stateId?: string;
	externalId?: string;
	externalSource?: string;
	/** Parent work item UUID (used for acceptance-criteria sub-items). */
	parent?: string;
}

/**
 * Update payload. `name` is optional here (unlike create) so a partial update —
 * e.g. --status-only — can PATCH just the state without re-sending (and thus
 * clobbering) a board-side title edit.
 */
export type UpdateWorkItemInput = Omit<
	CreateWorkItemInput,
	"externalId" | "externalSource" | "name"
> & { name?: string };

export interface WorkItemRef {
	id: string;
	sequenceId: number;
}

/** Raw Plane work item as returned by create/list (subset we use). */
interface RawWorkItem {
	id: string;
	sequence_id: number;
}

/** A work item fetched for export, with related names resolved via `expand`. */
export interface FetchedWorkItem {
	id: string;
	sequenceId: number;
	name: string;
	/** Plane creation instant normalized to ISO-8601 UTC, or null when unavailable. */
	createdAt: string | null;
	/** Plane update instant normalized to ISO-8601 UTC, or null when unavailable. */
	updatedAt: string | null;
	/** Description as markdown (converted from Plane's description_html). */
	description: string | undefined;
	priority: PlanePriority | undefined;
	estimate: number | undefined;
	stateName: string | undefined;
	assigneeEmail: string | undefined;
	assigneeDisplayName: string | undefined;
	assigneeId?: string;
	labels: string[];
	externalSource: string | undefined;
	externalId: string | undefined;
	/** Parent work item UUID, if this item is a sub-item. */
	parent: string | undefined;
	/** State group: backlog | unstarted | started | completed | cancelled. */
	stateGroup: string | undefined;
}

/** Build the Plane work item request body shared by create and update. */
function buildBody(input: CreateWorkItemInput | UpdateWorkItemInput): Record<string, unknown> {
	const body: Record<string, unknown> = {};

	// Only send name when provided. Create always provides it; a partial update
	// (status-only) omits it so the board-side title is left untouched.
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.body !== undefined) {
		const html = markdownToHtml(input.body);
		if (html) {
			body.description_html = html;
		}
	}
	if (input.labelIds !== undefined) {
		body.labels = input.labelIds;
	}
	if (input.assigneeId !== undefined) {
		body.assignees = [input.assigneeId];
	}
	if (input.priority !== undefined) {
		body.priority = input.priority;
	}
	if (input.estimate !== undefined) {
		body.point = input.estimate;
	}
	if (input.stateId !== undefined) {
		body.state = input.stateId;
	}
	if (input.parent !== undefined) {
		body.parent = input.parent;
	}
	if ("externalId" in input && input.externalId !== undefined) {
		body.external_id = input.externalId;
	}
	if ("externalSource" in input && input.externalSource !== undefined) {
		body.external_source = input.externalSource;
	}

	return body;
}

/** Create a new work item in a project. */
export async function createWorkItem(
	client: PlaneClient,
	projectId: string,
	input: CreateWorkItemInput,
): Promise<WorkItemRef> {
	try {
		const item = await client.createWorkItem<RawWorkItem>(projectId, buildBody(input));
		return { id: item.id, sequenceId: item.sequence_id };
	} catch (error) {
		if (error instanceof PlaneApiError) {
			throw error;
		}
		throw new PlaneApiError(
			`Failed to create work item: "${input.name}" - ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Update an existing work item by its UUID. */
export async function updateWorkItem(
	client: PlaneClient,
	projectId: string,
	workItemId: string,
	input: UpdateWorkItemInput,
): Promise<WorkItemRef> {
	try {
		const item = await client.updateWorkItem<RawWorkItem>(projectId, workItemId, buildBody(input));
		return { id: item.id, sequenceId: item.sequence_id };
	} catch (error) {
		if (error instanceof PlaneApiError) {
			throw error;
		}
		throw new PlaneApiError(
			`Failed to update work item: "${workItemId}" - ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * Look up a work item by its external id within a project, used to make
 * imports idempotent. Returns null when no match exists.
 */
export async function findWorkItemByExternalId(
	client: PlaneClient,
	projectId: string,
	externalId: string,
	externalSource: string,
): Promise<WorkItemRef | null> {
	// Plane's external_id filter returns a single object on a hit (or a 404 →
	// null on a miss), but defend against a paginated shape just in case.
	const data = await client.findWorkItemByExternalId<RawWorkItem | { results?: RawWorkItem[] }>(
		projectId,
		externalId,
		externalSource,
	);
	if (!data) {
		return null;
	}
	const match =
		"results" in data && Array.isArray(data.results) ? data.results[0] : (data as RawWorkItem);
	return match?.id ? { id: match.id, sequenceId: match.sequence_id } : null;
}

/** Normalize a title for duplicate detection: trim, lowercase, collapse whitespace. */
export function normalizeTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ");
}

interface RawComment {
	comment_html?: string;
	comment_stripped?: string;
}

/** The comment surface ensureComment needs (narrow, so tests can stub it). */
export interface CommentClient {
	readonly maxRetries: number;
	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]>;
	createWorkItemComment<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T>;
}

/** Transient = worth replaying: network-ambiguous (no status), 429, or 5xx. */
async function hasMarkerComment(
	client: CommentClient,
	projectId: string,
	workItemId: string,
	marker: string,
): Promise<boolean> {
	const existing = await client.listWorkItemComments<RawComment>(projectId, workItemId);
	return existing.some(
		(c) => (c.comment_html ?? "").includes(marker) || (c.comment_stripped ?? "").includes(marker),
	);
}

/**
 * Post a comment on a work item only if one bearing `marker` isn't already there,
 * so repeated runs (e.g. groom) don't spam duplicate notes. `body` should embed
 * `marker` so the next run can find it. Returns whether it actually posted.
 *
 * Duplicate-safety (A10 — verify before replaying an ambiguous write): comment
 * creation is NOT idempotent, so the POST runs with the client's blind retry
 * DISABLED. On a failure, the comment list is re-checked: if the marker is now
 * present, the write actually landed (timed-out-but-committed) and we are done —
 * this is the case where the old client-level replay posted duplicates. Only a
 * verified-absent, transient failure is retried (with backoff, up to the
 * client's retry budget); permanent errors (4xx) surface immediately. If the
 * verification read itself fails, the original error is thrown WITHOUT another
 * POST — never replay a write whose durable state cannot be confirmed.
 *
 * Rate-limit courtesy is preserved: a failed create that carried Retry-After
 * (surfaced as PlaneApiError.retryAfterMs) paces the next attempt with the
 * SERVER-directed delay; otherwise local exponential backoff (capped 5s)
 * applies. The create count stays bounded either way.
 */
export async function ensureComment(
	client: CommentClient,
	projectId: string,
	workItemId: string,
	marker: string,
	body: string,
	opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<"posted" | "exists"> {
	if (await hasMarkerComment(client, projectId, workItemId, marker)) {
		return "exists";
	}
	const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const attempts = Math.max(1, client.maxRetries + 1);
	for (let attempt = 1; ; attempt++) {
		try {
			await client.createWorkItemComment(
				projectId,
				workItemId,
				{ comment_html: body },
				{ maxRetries: 0 },
			);
			return "posted";
		} catch (error) {
			let landed: boolean;
			try {
				landed = await hasMarkerComment(client, projectId, workItemId, marker);
			} catch {
				throw error; // cannot verify durable state -> never replay the write
			}
			if (landed) {
				return "posted"; // the ambiguous write committed; a replay would duplicate
			}
			if (!isTransientPlaneError(error) || attempt >= attempts) {
				throw error;
			}
			// Honor a server-directed Retry-After when the failed create carried one;
			// otherwise pace with local exponential backoff.
			const serverDelay = error instanceof PlaneApiError ? error.retryAfterMs : undefined;
			await sleep(serverDelay ?? Math.min(500 * 2 ** (attempt - 1), 5000));
		}
	}
}

/**
 * A one-shot, in-memory index of every work item in a project, with the lookup
 * maps the importer needs (duplicate guard, hashless-linked adopt) and export
 * completeness needs. Built from ONE paginated list — never a per-item GET — so
 * it is cheap to consult across a whole import run.
 */
export interface ProjectIndex {
	items: FetchedWorkItem[];
	/** Work item UUID -> item. */
	byId: Map<string, FetchedWorkItem>;
	/** Human identifier ("ENG-42") -> item. */
	byIdentifier: Map<string, FetchedWorkItem>;
	/** Normalized title -> items (a list, since duplicate titles are the thing we detect). */
	byNormalizedTitle: Map<string, FetchedWorkItem[]>;
	/** Parent UUID -> child items (e.g. acceptance-criteria sub-items). */
	childrenByParent: Map<string, FetchedWorkItem[]>;
}

/** Fetch a project's entire work-item set once and build lookup maps over it. */
export async function fetchProjectIndex(
	client: PlaneClient,
	projectId: string,
	projectIdentifier: string,
): Promise<ProjectIndex> {
	const items = await fetchWorkItems(client, projectId);
	const byId = new Map<string, FetchedWorkItem>();
	const byIdentifier = new Map<string, FetchedWorkItem>();
	const byNormalizedTitle = new Map<string, FetchedWorkItem[]>();
	const childrenByParent = new Map<string, FetchedWorkItem[]>();

	for (const item of items) {
		byId.set(item.id, item);
		byIdentifier.set(`${projectIdentifier}-${item.sequenceId}`, item);

		const titleKey = normalizeTitle(item.name);
		const titled = byNormalizedTitle.get(titleKey);
		if (titled) {
			titled.push(item);
		} else {
			byNormalizedTitle.set(titleKey, [item]);
		}

		if (item.parent) {
			const kids = childrenByParent.get(item.parent);
			if (kids) {
				kids.push(item);
			} else {
				childrenByParent.set(item.parent, [item]);
			}
		}
	}

	return { items, byId, byIdentifier, byNormalizedTitle, childrenByParent };
}

/** Fetch work items in a project for export, resolving related names via `expand`. */
export async function fetchWorkItems(
	client: PlaneClient,
	projectId: string,
	query: Record<string, string | number | boolean | undefined> = {},
): Promise<FetchedWorkItem[]> {
	const raw = await client.listWorkItems<Record<string, unknown>>(projectId, {
		expand: "state,assignees,labels",
		...query,
	});
	return raw.map(normalizeFetched);
}

/**
 * Values a cast produces that LOOK like an id and are not one.
 *
 * The review suggested requiring a UUID shape. Plane does use UUIDs, but that is
 * stricter than the defect needs and would reject a deployment whose ids are
 * shaped differently for no safety gain — the failure being prevented is an
 * absent value reaching an identifier or URL, not an unfamiliar format.
 */
const NON_IDS = new Set(["", "undefined", "null", "[object Object]", "NaN"]);

function normalizeFetched(item: Record<string, unknown>): FetchedWorkItem {
	// IDENTITY FIRST, and validated rather than cast.
	//
	// `id` and `sequence_id` were taken on trust, so a malformed response produced
	// `identifier: DATA-undefined` and `url: .../issues/undefined` — visibly
	// broken, which is the lucky case. The unlucky one is a STRING sequence:
	// `"42"` became the entirely plausible `DATA-42`, pointing at whatever really
	// is item 42. A wrong identifier that looks right is worse than one that
	// looks wrong, and both are worse than a refusal.
	if (typeof item.id !== "string" || NON_IDS.has(item.id.trim())) {
		throw new PlaneApiError(
			`Plane work item returned an invalid id (${JSON.stringify(item.id)}); expected a non-empty identifier. ` +
				"Refusing to build a work-item URL from it.",
		);
	}
	if (
		typeof item.sequence_id !== "number" ||
		!Number.isSafeInteger(item.sequence_id) ||
		item.sequence_id <= 0
	) {
		throw new PlaneApiError(
			`Plane work item ${item.id} returned an invalid sequence_id (${JSON.stringify(item.sequence_id)}); expected a positive integer. ` +
				'A string such as "42" would coerce to a plausible-looking identifier for a different item.',
		);
	}
	if (typeof item.name !== "string") {
		throw new PlaneApiError(
			`Plane work item ${item.id} returned an invalid name; expected a string`,
		);
	}
	const state = item.state as { name?: string; group?: string } | string | undefined;
	const stateName = state && typeof state === "object" ? state.name : undefined;
	const stateGroup = state && typeof state === "object" ? state.group : undefined;

	const assignees = (item.assignees as Array<Record<string, unknown>> | undefined) ?? [];
	const firstAssignee = assignees[0];

	const labels = (item.labels as Array<Record<string, unknown> | string> | undefined) ?? [];
	const labelNames = labels
		.map((l) => (typeof l === "object" ? (l.name as string) : undefined))
		.filter((n): n is string => typeof n === "string");

	const priorityRaw = item.priority as string | undefined;
	const priority =
		priorityRaw && priorityRaw !== "none" ? (priorityRaw as PlanePriority) : undefined;

	const estimateRaw = item.point;
	const estimate = typeof estimateRaw === "number" ? estimateRaw : undefined;
	const normalizeInstant = (value: unknown): string | null => {
		if (typeof value !== "string" || value.trim().length === 0) return null;
		const milliseconds = Date.parse(value);
		return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
	};

	return {
		id: item.id as string,
		sequenceId: item.sequence_id as number,
		name: item.name,
		createdAt: normalizeInstant(item.created_at),
		updatedAt: normalizeInstant(item.updated_at),
		description: htmlToMarkdown(item.description_html as string | undefined) || undefined,
		priority,
		estimate,
		stateName,
		assigneeEmail: firstAssignee?.email as string | undefined,
		assigneeDisplayName: firstAssignee?.display_name as string | undefined,
		assigneeId: firstAssignee?.id as string | undefined,
		labels: labelNames,
		externalSource: (item.external_source as string) || undefined,
		externalId: (item.external_id as string) || undefined,
		parent: (item.parent as string) || undefined,
		stateGroup,
	};
}
