import { createHash } from "node:crypto";

/**
 * The fields that determine what an import would write to a Plane work item.
 * The hash is computed over the RENDERED payload (description as HTML) so that
 * cosmetic markdown reflow that produces identical HTML does NOT trigger a write.
 * Flags that change the payload (sync-criteria, source label via the merged label
 * set) are folded in, so toggling them invalidates the hash as intended.
 */
export interface PayloadHashInput {
	name: string;
	/** Description rendered to HTML (what Plane actually stores). */
	descriptionHtml: string;
	priority: string | null;
	/** State name (e.g. "Backlog", "Done"). */
	status: string | null;
	estimate: number | null;
	/** Effective label names (story + defaults + source label), order-insensitive. */
	labels: string[];
	assignee: string | null;
	syncCriteria: boolean;
	/** Acceptance criteria, only meaningful when syncCriteria is true. */
	criteria: Array<{ text: string; checked: boolean }>;
	/**
	 * Parent identifier (e.g. "DATA-12") when the story nests under one. Included in
	 * the hash ONLY when present, so parentless stories keep a stable hash (existing
	 * synced files stay warm) while a parent edit still triggers a re-sync.
	 */
	parent?: string | null;
}

/**
 * Deterministic content hash of the intended import payload.
 *
 * Computed identically at write time (to store in `plane_hash`) and read time
 * (to compare on re-import). A match means a re-import would be a no-op, so it is
 * skipped with zero API writes. Labels are sorted so ordering never matters;
 * criteria are included only when they would actually be synced.
 *
 * Returns a 16-hex-char (64-bit) digest — short enough to sit cleanly in YAML,
 * with negligible collision risk for the per-item, across-edits comparison it
 * serves (the item is already identified by plane_id).
 */
export function payloadHash(input: PayloadHashInput): string {
	const canonical = {
		name: input.name,
		descriptionHtml: input.descriptionHtml,
		priority: input.priority ?? null,
		status: input.status ?? null,
		estimate: input.estimate ?? null,
		labels: [...input.labels].sort(),
		assignee: input.assignee ?? null,
		syncCriteria: input.syncCriteria,
		criteria: input.syncCriteria
			? input.criteria.map((c) => ({ text: c.text, checked: c.checked }))
			: [],
		// Only present when set, so parentless stories keep their pre-parent hash.
		...(input.parent ? { parent: input.parent } : {}),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}
