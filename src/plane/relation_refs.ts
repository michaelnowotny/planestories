import { PlaneApiError } from "../errors.ts";
import type { PlaneIssueRelations } from "./client.ts";

/**
 * Plane returns relation references in TWO shapes, decided by endpoint dialect:
 *
 *   /issues/     (cloud)         -> "4a31240a-ac16-48ee-a928-331bfdba8125"
 *   /work-items/ (self-hosted CE) -> { project_id: "fb1c…", issue_id: "2cf5…" }
 *
 * Both were measured live on 2026-08-17. `PlaneIssueRelations` declares these
 * fields as `string[]`, so TypeScript cheerfully accepted objects flowing through
 * as ids — every consumer that used a ref directly built keys from
 * "[object Object]" and therefore saw ZERO existing relations on CE.
 *
 * That is not a cosmetic bug. It made `import` re-create every relation on every
 * run, alternating direction with batch membership, which accumulated reversed
 * edges and produced a two-node cycle on the live board (DATA-2569 <-> DATA-2570)
 * — a cycle the guard could not prevent, because the guard reads the same blind
 * edge list. It also silently emptied the atlas dependency graph, the spec
 * packets handed to agents, the epic rollup, and doctor's dangling check.
 *
 * So normalization happens ONCE, at the client boundary (`getRelations`), and
 * every consumer downstream sees bare id strings on every instance. Normalizing
 * per-consumer is what produced this bug: snapshot.ts did it and was correct,
 * five other call sites did not and were wrong.
 */
export function normalizeRelationRef(ref: unknown): string | null {
	if (typeof ref === "string") return ref;
	if (ref !== null && typeof ref === "object") {
		const issueId = (ref as { issue_id?: unknown }).issue_id;
		if (typeof issueId === "string") return issueId;
	}
	return null;
}

const RELATION_FIELDS = [
	"blocking",
	"blocked_by",
	"relates_to",
	"duplicate",
	"start_before",
	"start_after",
	"finish_before",
	"finish_after",
] as const;

/**
 * Normalize a raw relations payload so every reference is a bare work-item id.
 *
 * FAILS CLOSED on a reference shape we do not understand: silently dropping one
 * would delete an edge from the caller's view, and a caller that cannot see an
 * edge deletes it from the board or re-creates it. Absence must never be
 * manufactured from confusion (the house null-ban).
 */
export function normalizeRelations(raw: unknown): PlaneIssueRelations {
	const source = (raw ?? {}) as Record<string, unknown>;
	const out = {} as PlaneIssueRelations;
	for (const field of RELATION_FIELDS) {
		const list = source[field];
		if (list === undefined || list === null) {
			out[field] = [];
			continue;
		}
		if (!Array.isArray(list)) {
			throw new PlaneApiError(
				`Relations payload field "${field}" is not an array: ${JSON.stringify(list)}`,
				500,
			);
		}
		out[field] = list.map((ref) => {
			const id = normalizeRelationRef(ref);
			if (id === null) {
				throw new PlaneApiError(
					`Unrecognizable ${field} relation reference from Plane: ${JSON.stringify(ref)}. ` +
						"Refusing to treat it as absent — that would silently drop a dependency edge.",
					500,
				);
			}
			return id;
		});
	}
	return out;
}
