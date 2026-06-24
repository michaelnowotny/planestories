import { PlaneApiError } from "../errors.ts";

export const DEFAULT_PLANE_BASE_URL = "https://api.plane.so";

export interface PlaneClientOptions {
	apiKey: string;
	workspaceSlug: string;
	/** API base URL. Defaults to Plane Cloud (https://api.plane.so). */
	baseUrl?: string;
}

interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	/** When true, a 404 response resolves to null instead of throwing. */
	allowNotFound?: boolean;
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
 */
export class PlaneClient {
	readonly apiKey: string;
	readonly workspaceSlug: string;
	readonly baseUrl: string;
	readonly webBaseUrl: string;

	constructor(options: PlaneClientOptions) {
		this.apiKey = options.apiKey;
		this.workspaceSlug = options.workspaceSlug;
		this.baseUrl = (options.baseUrl ?? DEFAULT_PLANE_BASE_URL).replace(/\/+$/, "");
		this.webBaseUrl = deriveWebBaseUrl(this.baseUrl);
	}

	/** Absolute browser URL for a work item, used in markdown write-back. */
	workItemWebUrl(projectId: string, workItemId: string): string {
		return `${this.webBaseUrl}/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}`;
	}

	private workspacePath(suffix: string): string {
		return `/api/v1/workspaces/${this.workspaceSlug}${suffix}`;
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

		let response: Response;
		try {
			response = await fetch(url.toString(), {
				method,
				headers: {
					"X-API-Key": this.apiKey,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			});
		} catch (error) {
			throw new PlaneApiError(
				`Network error calling Plane API (${method} ${path}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		if (response.status === 404 && options.allowNotFound) {
			return null as T;
		}

		if (!response.ok) {
			const detail = await safeErrorDetail(response);
			throw new PlaneApiError(
				`Plane API ${method} ${path} failed (${response.status} ${response.statusText})${
					detail ? `: ${detail}` : ""
				}`,
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

	createWorkItem<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		return this.request<T>("POST", this.workspacePath(`/projects/${projectId}/issues/`), {
			body,
		});
	}

	updateWorkItem<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
	): Promise<T> {
		return this.request<T>(
			"PATCH",
			this.workspacePath(`/projects/${projectId}/issues/${workItemId}/`),
			{ body },
		);
	}

	listWorkItems<T>(projectId: string, query: RequestOptions["query"] = {}): Promise<T[]> {
		return this.listAll<T>(`/projects/${projectId}/issues/`, query);
	}

	/** Retrieve a single work item (e.g. to read its current labels before merging). */
	getWorkItem<T>(projectId: string, workItemId: string): Promise<T> {
		return this.request<T>(
			"GET",
			this.workspacePath(`/projects/${projectId}/issues/${workItemId}/`),
		);
	}

	/** Permanently delete a work item (204 on success). */
	deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
		return this.request<void>(
			"DELETE",
			this.workspacePath(`/projects/${projectId}/issues/${workItemId}/`),
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
		return this.request<T | null>("GET", this.workspacePath(`/projects/${projectId}/issues/`), {
			query: { external_id: externalId, external_source: externalSource },
			allowNotFound: true,
		});
	}
}

export function createPlaneClient(options: PlaneClientOptions): PlaneClient {
	return new PlaneClient(options);
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
