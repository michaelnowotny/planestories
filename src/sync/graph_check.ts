import { fetchRelationsWithSweep } from "../atlas/relations.ts";
import { PlaneApiError } from "../errors.ts";
import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import type { FetchedWorkItem, ProjectIndex } from "../plane/issues.ts";
import { isCriterionChild } from "./board-story.ts";

/** A relation on the board whose target work item isn't in the project. */
export interface DanglingRelation {
	/** The item that holds the relation (human identifier). */
	from: string;
	/** The relation kind: blocked_by | blocks | relates_to. */
	relation: string;
	/** The unresolved target work-item UUID. */
	targetId: string;
}

export interface GraphCheckReport {
	/** Relations pointing at a work item not present in this project (deleted / cross-project). */
	dangling: DanglingRelation[];
	/** The single paced relation sweep, shared with optional doctor checks. */
	relations: Map<string, PlaneIssueRelations>;
}

/**
 * Board-side dependency-graph hygiene: find relations whose target work item is not
 * in the project index (a deleted item, or one that left the list). Complements the
 * file-side `lint` dangling-reference check. Read-only.
 *
 * Note: a dependency CYCLE is intentionally NOT checked here — Plane refuses to persist
 * a cycle-creating relation (verified; see DESIGN_DECISIONS_tier1.md), so no cycle can
 * exist on the board. The file-side `lint` still checks cycles at authoring time.
 *
 * `relates_to` is symmetric and auto-mirrored, so scanning it from every item would
 * double-report; only the directional sets (`blocked_by`, `blocking`) plus a single
 * side of `relates_to` are considered — see the per-item handling below.
 */
export async function checkDependencyGraph(
	client: PlaneClient,
	projectId: string,
	projectIdentifier: string,
	index: ProjectIndex,
	onProgress?: (done: number, total: number) => void,
): Promise<GraphCheckReport> {
	// Only real stories/epics carry dependency relations (criterion sub-items don't).
	const items = index.items.filter((item) => !isCriterionChild(item));

	const ident = (item: FetchedWorkItem): string => `${projectIdentifier}-${item.sequenceId}`;
	const seenRelatesTo = new Set<string>(); // dedup the symmetric relates_to edges

	// Relations with the paced rate-limit sweep — FAIL-HARD on residual failure:
	// doctor is an acceptance gate, and silently missing relations would
	// under-report dangling edges (a false-clean).
	const rel = await fetchRelationsWithSweep(
		client,
		projectId,
		items,
		client.concurrency?.() ?? 6,
		onProgress,
	);
	if (rel.failed > 0) {
		throw new PlaneApiError(
			`${rel.failed} relation lookup(s) failed even after the paced retry pass — ` +
				"dependency-graph check aborted (a partial scan would under-report dangling relations). Re-run.",
		);
	}

	const perItem = items.map((item) => {
		const relations = rel.relationsById.get(item.id);
		if (!relations) {
			throw new PlaneApiError(`missing relations for ${ident(item)}`);
		}
		const dangling: DanglingRelation[] = [];

		for (const targetId of relations.blocked_by ?? []) {
			if (!index.byId.get(targetId)) {
				dangling.push({ from: ident(item), relation: "blocked_by", targetId });
			}
		}
		for (const targetId of relations.blocking ?? []) {
			if (!index.byId.get(targetId)) {
				dangling.push({ from: ident(item), relation: "blocks", targetId });
			}
		}
		for (const targetId of relations.relates_to ?? []) {
			// Symmetric edge — report each unresolved target once, attributed to whichever
			// endpoint we scanned first (the other endpoint may itself be the missing item).
			const key = [item.id, targetId].sort().join("|");
			if (!index.byId.get(targetId) && !seenRelatesTo.has(key)) {
				seenRelatesTo.add(key);
				dangling.push({ from: ident(item), relation: "relates_to", targetId });
			}
		}
		return dangling;
	});

	return { dangling: perItem.flat(), relations: rel.relationsById };
}
