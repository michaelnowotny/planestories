import { PlaneApiError } from "../errors.ts";
import type { PlaneDialectSource, ResolvedConfig } from "../types.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "./client.ts";

export interface DialectResolution {
	dialect: PlaneEndpointDialect;
	source: PlaneDialectSource;
	/** Present when the current default had to be used without endpoint evidence. */
	reason?: string;
}

export class DialectDetectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DialectDetectionError";
	}
}

export interface ReadDialectClient {
	readonly dialect: PlaneEndpointDialect;
	/** A true one-page read. PlaneClient implements this without following cursors. */
	sampleWorkItem?<T>(projectId: string): Promise<T | null>;
	/** Compatibility path for duck-typed replication clients. May enumerate fully. */
	listWorkItems<T>(
		projectId: string,
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
}

export interface ReadDialectDetectionOptions {
	/** Replication must consider an archived-only source; ordinary live commands need not. */
	includeArchived?: boolean;
}

/**
 * Select the endpoint family from read-only evidence.
 *
 * Both families can list work items on the operator's CE deployment; relations
 * are the discriminator. We sample ONE item and reuse its UUID for both relation
 * GETs. No create/update/delete is ever issued here.
 */
export async function detectReadDialect(
	factory: (dialect: PlaneEndpointDialect) => ReadDialectClient,
	projectId: string,
	options: ReadDialectDetectionOptions = {},
): Promise<DialectResolution> {
	let probeItem: { id: string } | null = null;
	for (const dialect of ["issues", "work-items"] as const) {
		const client = factory(dialect);
		try {
			probeItem = await sampleLiveItem(client, projectId);
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
		if (probeItem) break;
	}

	if (!probeItem && options.includeArchived !== false) {
		for (const dialect of ["issues", "work-items"] as const) {
			const client = factory(dialect);
			let archived: Array<{ id: string }> | null;
			try {
				archived = await client.listArchivedWorkItems<{ id: string }>(projectId);
			} catch (error) {
				if (isNotFoundError(error)) continue;
				throw error;
			}
			probeItem = archived?.[0] ?? null;
			if (probeItem) break;
		}
	}

	if (!probeItem) {
		return {
			dialect: "issues",
			source: "fallback",
			reason: "no work item was available to test the relation endpoint",
		};
	}

	for (const dialect of ["issues", "work-items"] as const) {
		try {
			await factory(dialect).getRelations(projectId, probeItem.id);
			return { dialect, source: "detected" };
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
	}

	throw new DialectDetectionError(
		"Neither the /issues/ nor the /work-items/ path family serves the relation read endpoint",
	);
}

async function sampleLiveItem(
	client: ReadDialectClient,
	projectId: string,
): Promise<{ id: string } | null> {
	if (client.sampleWorkItem) {
		return client.sampleWorkItem<{ id: string }>(projectId);
	}
	return (await client.listWorkItems<{ id: string }>(projectId))[0] ?? null;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof PlaneApiError && error.status === 404;
}

/**
 * Per-process dialect cache. An already-resolved value is checked BEFORE the
 * cache; a raw configured value is therefore always authoritative, while a
 * detected/fallback value keeps its provenance if it is passed through again.
 */
export class DialectResolver {
	private readonly byContext = new Map<string, Promise<DialectResolution>>();

	async resolve(
		config: ResolvedConfig,
		detect: () => Promise<DialectResolution>,
	): Promise<DialectResolution> {
		if (config.dialect !== undefined) {
			return {
				dialect: config.dialect,
				source: config.dialectSource ?? "configured",
			};
		}

		const key = dialectCacheKey(config);
		const cached = this.byContext.get(key);
		if (cached) return cached;

		const pending = (async (): Promise<DialectResolution> => {
			try {
				return await detect();
			} catch (error) {
				return {
					dialect: "issues",
					source: "fallback",
					reason: describeError(error),
				};
			}
		})();
		this.byContext.set(key, pending);
		return pending;
	}
}

/** True only for a user/config supplied dialect, never a runtime resolution. */
export function isDialectConfigured(config: ResolvedConfig): boolean {
	return (
		config.dialect !== undefined &&
		(config.dialectSource === undefined || config.dialectSource === "configured")
	);
}

export function dialectCacheKey(config: ResolvedConfig): string {
	return config.contextName
		? `context:${config.contextName}\u0000${config.baseUrl}\u0000${config.workspaceSlug}`
		: `default:${config.baseUrl}\u0000${config.workspaceSlug}`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
