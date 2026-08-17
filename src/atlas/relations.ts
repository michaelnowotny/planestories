import type { PlaneIssueRelations } from "../plane/client.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";

/** The slice of PlaneClient the relation fetch needs (narrow for testability). */
export interface RelationsClient {
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
	/** Derived per-instance concurrency, when a rate profile is configured. */
	concurrency?(): number | undefined;
}

export interface RelationsFetchResult {
	relationsById: Map<string, PlaneIssueRelations>;
	/** Items whose lookup still failed after the paced second pass. */
	failed: number;
	/** Items the sweep recovered after a first-pass failure (for reporting). */
	recovered: number;
}

/**
 * Fetch per-item dependency relations with a two-phase strategy tuned for
 * Plane's rate limits. Phase 1 runs at modest concurrency; any item whose
 * lookup fails (typically a 429 that outlived the client's own Retry-After
 * backoff) is retried in phase 2 SEQUENTIALLY — one request at a time, letting
 * the client's backoff pace the stream — which recovers most rate-limited
 * lookups at the cost of a slower tail. There is no bulk-relations endpoint in
 * Plane's public API, so per-item GETs are the only way to obtain edges; a
 * still-failing item drops only its own edges (a graph with most edges beats
 * no graph).
 */
export async function fetchRelationsWithSweep(
	client: RelationsClient,
	projectId: string,
	items: ReadonlyArray<{ id: string }>,
	concurrency = client.concurrency?.() ?? 4,
	onProgress?: (done: number, total: number) => void,
): Promise<RelationsFetchResult> {
	const failedItems: Array<{ id: string }> = [];
	let done = 0;
	const total = items.length;
	const pairs = await mapWithConcurrency([...items], concurrency, async (item) => {
		try {
			return await fetchOne(item);
		} finally {
			done++;
			onProgress?.(done, total);
		}
	});
	async function fetchOne(item: { id: string }) {
		try {
			return [item.id, await client.getRelations(projectId, item.id)] as const;
		} catch {
			failedItems.push(item);
			return null;
		}
	}
	const relationsById = new Map<string, PlaneIssueRelations>(
		pairs.filter((p): p is readonly [string, PlaneIssueRelations] => p !== null),
	);

	let recovered = 0;
	let failed = 0;
	for (const item of failedItems) {
		try {
			relationsById.set(item.id, await client.getRelations(projectId, item.id));
			recovered++;
		} catch {
			failed++;
		}
	}
	// Rebuild in INPUT order: recovered entries append after the sweep, which
	// would make edge order (and the rendered HTML) vary with request timing —
	// the atlas is a diff-stable artifact, so iteration order must be data
	// order, never network order.
	const ordered = new Map<string, PlaneIssueRelations>();
	for (const item of items) {
		const rel = relationsById.get(item.id);
		if (rel) ordered.set(item.id, rel);
	}
	return { relationsById: ordered, failed, recovered };
}
