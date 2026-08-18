import { ParseError } from "../errors.ts";
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
 * Failures here are ParseError, NOT PlaneApiError: a malformed payload is
 * DETERMINISTIC. PlaneApiError carries an HTTP status and `isRetryableStatus`
 * classifies 5xx as transient, so a synthetic 500 would have invited callers to
 * retry a failure that cannot possibly succeed on a second attempt — the exact
 * thing the "retry only classified-transient failures" rule forbids.
 *
 * So normalization happens ONCE, at the client boundary (`getRelations`), and
 * every consumer downstream sees bare id strings on every instance. Normalizing
 * per-consumer is what produced this bug: snapshot.ts did it and was correct,
 * five other call sites did not and were wrong.
 */
export function normalizeRelationRef(ref: unknown): string | null {
	// An EMPTY id is rejected, not returned: it would build a lookup key like
	// "block:>item-a" that matches nothing — the same silent-miss the object
	// shape caused, just with a different empty value.
	if (typeof ref === "string") return ref.trim() === "" ? null : ref;
	if (ref !== null && typeof ref === "object") {
		const issueId = (ref as { issue_id?: unknown }).issue_id;
		if (typeof issueId === "string" && issueId.trim() !== "") return issueId;
	}
	return null;
}

/**
 * Every relation kind, in canonical order — the SINGLE list.
 *
 * `src/replicate/types.ts` re-exports this rather than keeping its own copy: a
 * kind added to only one of two lists would be silently dropped here while
 * surviving elsewhere, which is the same silent-loss class this module exists
 * to prevent.
 */
export const RELATION_KINDS = [
	"blocked_by",
	"blocking",
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
 * FAILS CLOSED twice over, and the distinction between the two is the whole
 * point:
 *
 * - An unrecognizable REFERENCE throws. Dropping it would delete an edge from
 *   the caller's view, and a caller that cannot see an edge deletes it from the
 *   board or re-creates it forever.
 * - An unrecognizable PAYLOAD throws too. This is the subtler one and it was
 *   caught in review: `raw ?? {}` used to turn `undefined`, `null`, `[]`, `42`
 *   and `"oops"` into eight empty arrays — a confident "this item has no
 *   dependencies". `request()` returns `undefined` for a 200 whose body is
 *   empty, truncated, or HTML, so that path is REACHABLE, and it reproduces the
 *   exact defect this module was written to fix. Before normalization existed
 *   those payloads exploded at the consumer and the sweeps counted a failed
 *   lookup; turning them into success would have been a regression.
 *
 * A missing KIND on a real object is genuinely known-empty (Plane omits empty
 * kinds), which is why that case still defaults to `[]`. Absence of a key means
 * empty; absence of the object means unknown. The null-ban is about not
 * confusing the two.
 */
export function normalizeRelations(raw: unknown): PlaneIssueRelations {
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ParseError(
			`Relations payload is not an object: ${JSON.stringify(raw) ?? String(raw)}. ` +
				"Refusing to read it as an empty relation set — that would report 'no dependencies' " +
				"for an item whose edges we simply failed to read.",
		);
	}
	const source = raw as Record<string, unknown>;
	const out = {} as PlaneIssueRelations;
	for (const field of RELATION_KINDS) {
		const list = source[field];
		if (list === undefined || list === null) {
			out[field] = [];
			continue;
		}
		if (!Array.isArray(list)) {
			throw new ParseError(
				`Relations payload field "${field}" is not an array: ${JSON.stringify(list)}`,
			);
		}
		out[field] = list.map((ref) => {
			const id = normalizeRelationRef(ref);
			if (id === null) {
				throw new ParseError(
					`Unrecognizable ${field} relation reference from Plane: ${JSON.stringify(ref)}. ` +
						"Refusing to treat it as absent — that would silently drop a dependency edge.",
				);
			}
			return id;
		});
	}
	return out;
}
