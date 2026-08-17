import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import type { ProjectIndex } from "../plane/issues.ts";
import type { ImportResult, RelationChange, UserStory } from "../types.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";

const PLANESTORIES_EXTERNAL_SOURCE = "planestories";

export interface RelationSyncStory {
	story: UserStory;
	result: ImportResult;
}

export interface RelationProject {
	id: string;
	identifier: string;
}

export interface RelationReconcileResult {
	created: number;
	removed: number;
	warnings: string[];
	errors: string[];
	changes: RelationChange[];
	/**
	 * Synced issue UUIDs whose declared relations were NOT written (because a cycle
	 * aborted the whole relation phase). The importer withholds plane_hash for exactly
	 * these stories so a warm hash never falsely claims relations were synced. Empty on
	 * a successful reconcile.
	 */
	hashWithholdIds: Set<string>;
}

interface BlockEdge {
	kind: "block";
	blocker: string;
	blocked: string;
	key: string;
}

interface RelatesEdge {
	kind: "relates";
	left: string;
	right: string;
	key: string;
}

type Edge = BlockEdge | RelatesEdge;

const EMPTY_RELATIONS: PlaneIssueRelations = {
	blocking: [],
	blocked_by: [],
	relates_to: [],
	duplicate: [],
	start_before: [],
	start_after: [],
	finish_before: [],
	finish_after: [],
};

/** Reconcile one project's dependency graph after every story has a Plane UUID. */
export async function reconcileProjectRelations(
	client: PlaneClient,
	project: RelationProject,
	index: ProjectIndex,
	records: RelationSyncStory[],
	dryRun: boolean,
): Promise<RelationReconcileResult> {
	const warnings = records.flatMap((record) => record.story.relationValidationErrors ?? []);
	const errors: string[] = [];
	const desired = new Map<string, Edge>();
	const syncedIds = new Set<string>();
	const identifierById = new Map<string, string>();
	const ownIdByRecord = new Map<RelationSyncStory, string>();
	const batchIdByIdentifier = new Map<string, string>();

	for (const item of index.items) {
		identifierById.set(item.id, `${project.identifier}-${item.sequenceId}`);
	}

	for (let position = 0; position < records.length; position++) {
		const record = records[position] as RelationSyncStory;
		const ownId =
			record.result.planeId ??
			record.story.planeId ??
			(dryRun ? `dry-run:${project.id}:${position}` : undefined);
		if (!ownId) {
			continue;
		}
		ownIdByRecord.set(record, ownId);
		const ownIdentifier =
			record.result.planeIdentifier ??
			record.story.planeIdentifier ??
			identifierById.get(ownId) ??
			`"${record.story.title}"`;
		syncedIds.add(ownId);
		identifierById.set(ownId, ownIdentifier);
		const batchIdentifier = record.result.planeIdentifier ?? record.story.planeIdentifier;
		if (batchIdentifier) {
			const canonical = batchIdentifier.trim().toUpperCase();
			if (!batchIdByIdentifier.has(canonical)) batchIdByIdentifier.set(canonical, ownId);
		}
	}

	for (const record of records) {
		const ownId = ownIdByRecord.get(record);
		if (!ownId) continue;
		const ownIdentifier = identifierById.get(ownId) ?? `"${record.story.title}"`;
		const resolve = (targetIdentifier: string): string | undefined => {
			const target = findByIdentifier(index, targetIdentifier);
			if (target) {
				identifierById.set(target.id, `${project.identifier}-${target.sequenceId}`);
				return target.id;
			}
			const importedId = batchIdByIdentifier.get(targetIdentifier.trim().toUpperCase());
			if (importedId) {
				identifierById.set(importedId, targetIdentifier.toUpperCase());
				return importedId;
			}
			warnings.push(`${ownIdentifier}: dependency target ${targetIdentifier} was not found`);
			return undefined;
		};

		for (const targetIdentifier of record.story.blockedBy) {
			const blocker = resolve(targetIdentifier);
			if (blocker) addBlockEdge(desired, blocker, ownId, identifierById, warnings);
		}
		for (const targetIdentifier of record.story.blocks) {
			const blocked = resolve(targetIdentifier);
			if (blocked) addBlockEdge(desired, ownId, blocked, identifierById, warnings);
		}
		for (const targetIdentifier of record.story.relatesTo) {
			const related = resolve(targetIdentifier);
			if (related) addRelatesEdge(desired, ownId, related, identifierById, warnings);
		}
	}

	const relationFetchIds = new Set(syncedIds);
	for (const edge of desired.values()) {
		for (const endpoint of edgeEndpoints(edge)) relationFetchIds.add(endpoint);
	}
	const currentByIssue = new Map<string, PlaneIssueRelations>();
	const concurrency = client.concurrency() ?? 6;
	await mapWithConcurrency([...relationFetchIds], concurrency, async (issueId) => {
		if (issueId.startsWith("dry-run:")) {
			currentByIssue.set(issueId, cloneRelations(EMPTY_RELATIONS));
			return;
		}
		currentByIssue.set(issueId, await client.getRelations(project.id, issueId));
	});

	const current = collectCurrentEdges(currentByIssue);
	const preservedBlockEdges = [...current.values()].filter(
		(edge): edge is BlockEdge =>
			edge.kind === "block" && !desired.has(edge.key) && !canRemoveEdge(edge, index, syncedIds),
	);
	// Selective apply: a desired block edge is "cyclic" when its blocked node can already
	// reach its blocker through the desired+preserved graph — creating it would close a
	// cycle (which Plane itself also silently refuses). Skip ONLY those edges and still
	// sync every other relation, so one bad cycle in a large batch never blocks the rest.
	// (Cycles closed through >1 non-imported board hop aren't visible client-side and are
	// left to Plane's own guard — see docs/KNOWN_LIMITATIONS.md.)
	const blockAdjacency = buildBlockAdjacency([...desired.values(), ...preservedBlockEdges]);
	const cyclicEdgeKeys = new Set<string>();
	for (const edge of desired.values()) {
		if (edge.kind === "block" && reaches(blockAdjacency, edge.blocked, edge.blocker)) {
			cyclicEdgeKeys.add(edge.key);
		}
	}
	if (cyclicEdgeKeys.size > 0) {
		const cycle = findBlockCycle([...desired.values(), ...preservedBlockEdges]);
		errors.push(
			cycle
				? `dependency cycle (cyclic relations skipped): ${cycle
						.map((id) => identifierById.get(id) ?? id)
						.join(" -> ")}`
				: "dependency cycle detected; cyclic relations were skipped",
		);
	}
	// Withhold plane_hash ONLY for stories whose declared edge was skipped (their relation
	// was not written); every other story syncs its relations and keeps its warm hash.
	const hashWithholdIds = new Set<string>();
	for (const edge of desired.values()) {
		if (!cyclicEdgeKeys.has(edge.key)) continue;
		for (const endpoint of edgeEndpoints(edge)) {
			if (syncedIds.has(endpoint)) hashWithholdIds.add(endpoint);
		}
	}

	const changes = new Map<string, RelationChange>();
	const noteChange = (
		issueId: string,
		operation: "created" | "removed",
		description: string,
	): void => {
		const identifier = identifierById.get(issueId) ?? issueId;
		let change = changes.get(issueId);
		if (!change) {
			change = { identifier, created: [], removed: [] };
			changes.set(issueId, change);
		}
		change[operation].push(description);
	};

	const toCreate = [...desired.values()].filter(
		(edge) => !current.has(edge.key) && !cyclicEdgeKeys.has(edge.key),
	);
	const toRemove = [...current.values()].filter(
		(edge) => !desired.has(edge.key) && canRemoveEdge(edge, index, syncedIds),
	);

	for (const edge of toCreate) {
		if (edge.kind === "block") {
			if (syncedIds.has(edge.blocked)) {
				const blockerIdentifier = identifierById.get(edge.blocker) ?? edge.blocker;
				noteChange(edge.blocked, "created", `blocked_by ${blockerIdentifier}`);
			} else {
				const blockedIdentifier = identifierById.get(edge.blocked) ?? edge.blocked;
				noteChange(edge.blocker, "created", `blocking ${blockedIdentifier}`);
			}
		} else {
			const source = syncedIds.has(edge.left) ? edge.left : edge.right;
			const related = source === edge.left ? edge.right : edge.left;
			const relatedIdentifier = identifierById.get(related) ?? related;
			noteChange(source, "created", `relates_to ${relatedIdentifier}`);
		}
	}

	for (const edge of toRemove) {
		if (edge.kind === "block") {
			const blockerIdentifier = identifierById.get(edge.blocker) ?? edge.blocker;
			noteChange(edge.blocked, "removed", `blocked_by ${blockerIdentifier}`);
		} else {
			const relatedIdentifier = identifierById.get(edge.right) ?? edge.right;
			noteChange(edge.left, "removed", `relates_to ${relatedIdentifier}`);
		}
	}

	if (!dryRun) {
		// Apply removals first so reversing a block edge never creates a transient
		// two-node cycle on Plane.
		for (const edge of toRemove) {
			if (edge.kind === "block") {
				await client.removeRelation(project.id, edge.blocked, "blocked_by", edge.blocker);
			} else {
				await client.removeRelation(project.id, edge.left, "relates_to", edge.right);
			}
		}
		for (const edge of toCreate) {
			if (edge.kind === "block") {
				if (syncedIds.has(edge.blocked)) {
					await client.createRelation(project.id, edge.blocked, "blocked_by", [edge.blocker]);
				} else {
					await client.createRelation(project.id, edge.blocker, "blocking", [edge.blocked]);
				}
			} else {
				const source = syncedIds.has(edge.left) ? edge.left : edge.right;
				const related = source === edge.left ? edge.right : edge.left;
				await client.createRelation(project.id, source, "relates_to", [related]);
			}
		}
	}

	return {
		created: toCreate.length,
		removed: toRemove.length,
		warnings: [...new Set(warnings)],
		errors: [...new Set(errors)],
		changes: [...changes.values()],
		hashWithholdIds,
	};
}

function cloneRelations(relations: PlaneIssueRelations): PlaneIssueRelations {
	return {
		blocking: [...relations.blocking],
		blocked_by: [...relations.blocked_by],
		relates_to: [...relations.relates_to],
		duplicate: [...relations.duplicate],
		start_before: [...relations.start_before],
		start_after: [...relations.start_after],
		finish_before: [...relations.finish_before],
		finish_after: [...relations.finish_after],
	};
}

function findByIdentifier(index: ProjectIndex, identifier: string) {
	const canonical = identifier.trim().toUpperCase();
	return (
		index.byIdentifier.get(canonical) ??
		[...index.byIdentifier.entries()].find(([key]) => key.toUpperCase() === canonical)?.[1]
	);
}

function blockKey(blocker: string, blocked: string): string {
	return `block:${blocker}>${blocked}`;
}

function relatesKey(left: string, right: string): string {
	const [first, second] = [left, right].sort();
	return `relates:${first}|${second}`;
}

function addBlockEdge(
	edges: Map<string, Edge>,
	blocker: string,
	blocked: string,
	identifierById: Map<string, string>,
	warnings: string[],
): void {
	if (blocker === blocked) {
		warnings.push(`${identifierById.get(blocker) ?? blocker} cannot block itself`);
		return;
	}
	const edge: BlockEdge = {
		kind: "block",
		blocker,
		blocked,
		key: blockKey(blocker, blocked),
	};
	edges.set(edge.key, edge);
}

function addRelatesEdge(
	edges: Map<string, Edge>,
	left: string,
	right: string,
	identifierById: Map<string, string>,
	warnings: string[],
): void {
	if (left === right) {
		warnings.push(`${identifierById.get(left) ?? left} cannot relate to itself`);
		return;
	}
	const [first, second] = [left, right].sort();
	const edge: RelatesEdge = {
		kind: "relates",
		left: first as string,
		right: second as string,
		key: relatesKey(left, right),
	};
	edges.set(edge.key, edge);
}

function collectCurrentEdges(currentByIssue: Map<string, PlaneIssueRelations>): Map<string, Edge> {
	const edges = new Map<string, Edge>();
	for (const [issueId, relations] of currentByIssue) {
		for (const blocker of relations.blocked_by ?? []) {
			const edge: BlockEdge = {
				kind: "block",
				blocker,
				blocked: issueId,
				key: blockKey(blocker, issueId),
			};
			edges.set(edge.key, edge);
		}
		for (const blocked of relations.blocking ?? []) {
			const edge: BlockEdge = {
				kind: "block",
				blocker: issueId,
				blocked,
				key: blockKey(issueId, blocked),
			};
			edges.set(edge.key, edge);
		}
		for (const related of relations.relates_to ?? []) {
			const [left, right] = [issueId, related].sort();
			const edge: RelatesEdge = {
				kind: "relates",
				left: left as string,
				right: right as string,
				key: relatesKey(issueId, related),
			};
			edges.set(edge.key, edge);
		}
	}
	return edges;
}

function edgeEndpoints(edge: Edge): [string, string] {
	return edge.kind === "block" ? [edge.blocker, edge.blocked] : [edge.left, edge.right];
}

function canRemoveEdge(edge: Edge, index: ProjectIndex, syncedIds: Set<string>): boolean {
	const endpoints = edgeEndpoints(edge);
	return endpoints.every(
		(id) =>
			syncedIds.has(id) && index.byId.get(id)?.externalSource === PLANESTORIES_EXTERNAL_SOURCE,
	);
}

/** blocker -> set of blocked, over the block edges only. */
function buildBlockAdjacency(edges: Edge[]): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (edge.kind !== "block") continue;
		const targets = adjacency.get(edge.blocker) ?? new Set<string>();
		targets.add(edge.blocked);
		adjacency.set(edge.blocker, targets);
	}
	return adjacency;
}

/** True when `to` is reachable from `from` along block edges (DFS). */
function reaches(adjacency: Map<string, Set<string>>, from: string, to: string): boolean {
	if (from === to) return true;
	const seen = new Set<string>([from]);
	const stack = [from];
	while (stack.length > 0) {
		const node = stack.pop() as string;
		for (const next of adjacency.get(node) ?? []) {
			if (next === to) return true;
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return false;
}

function findBlockCycle(edges: Edge[]): string[] | null {
	const adjacency = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (edge.kind !== "block") continue;
		const targets = adjacency.get(edge.blocker) ?? new Set<string>();
		targets.add(edge.blocked);
		adjacency.set(edge.blocker, targets);
	}
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];

	const visit = (node: string): string[] | null => {
		const status = state.get(node);
		if (status === "visiting") {
			const start = path.indexOf(node);
			return [...path.slice(start), node];
		}
		if (status === "done") return null;
		state.set(node, "visiting");
		path.push(node);
		for (const target of adjacency.get(node) ?? []) {
			const cycle = visit(target);
			if (cycle) return cycle;
		}
		path.pop();
		state.set(node, "done");
		return null;
	};

	for (const node of adjacency.keys()) {
		const cycle = visit(node);
		if (cycle) return cycle;
	}
	return null;
}
