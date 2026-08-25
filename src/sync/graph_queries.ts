import type { AtlasGraph, AtlasNode, StatusGroup } from "../atlas/model.ts";
import { ConfigError } from "../errors.ts";
import { shellQuote } from "../utils/shell.ts";
import {
	type LeafDependencyProjection,
	NestedDependencyError,
	type ProjectedLeaf,
	projectLeafDependencies,
} from "./critical_path.ts";

const OPEN_GROUPS = new Set<StatusGroup>(["backlog", "unstarted", "started"]);
const NOT_STARTED_GROUPS = new Set<StatusGroup>(["backlog", "unstarted"]);

export interface GraphQueryRef {
	identifier: string | null;
	title: string;
	status: string | null;
	statusGroup: StatusGroup;
	kind: AtlasNode["kind"];
}

export interface ReadyQueryItem {
	item: GraphQueryRef;
	/** Completed/cancelled prerequisites, retained so the answer names its evidence. */
	blockers: GraphQueryRef[];
	/** Open direct successors that completing this item would immediately release. */
	unblocks: GraphQueryRef[];
}

export interface ReadyQueryReport {
	kind: "ready";
	scope: GraphQueryRef | null;
	items: ReadyQueryItem[];
	/** Matches before --limit; limiting the rows must not change the measured total. */
	matched: number;
	openConsidered: number;
	/** Status-unknown leaves excluded from the open-work predicate. */
	unknownStatus: number;
}

export interface BlockedQueryItem {
	item: GraphQueryRef;
	blockers: GraphQueryRef[];
}

export interface InconsistentQueryReport {
	kind: "inconsistent";
	scope: GraphQueryRef | null;
	doneWithUnfinishedBlockers: BlockedQueryItem[];
	notStartedWithDoneBlockers: BlockedQueryItem[];
	considered: number;
	unknownStatus: number;
}

export interface BlockedQueryReport {
	kind: "blocked";
	scope: GraphQueryRef | null;
	items: BlockedQueryItem[];
	openConsidered: number;
	unknownStatus: number;
}

export interface OrphansQueryReport {
	kind: "orphans";
	items: Array<{ item: GraphQueryRef }>;
	considered: number;
}

export interface AbandonedQueryItem {
	item: GraphQueryRef;
	/** Nearest cancelled/abandoned epic ancestor. */
	parent: GraphQueryRef;
}

export interface AbandonedQueryReport {
	kind: "abandoned";
	items: AbandonedQueryItem[];
	openConsidered: number;
	unknownStatus: number;
}

export type GraphQueryReport =
	| ReadyQueryReport
	| InconsistentQueryReport
	| BlockedQueryReport
	| OrphansQueryReport
	| AbandonedQueryReport;

export interface ScopedQueryOptions {
	epic?: string;
}

export interface ReadyQueryOptions extends ScopedQueryOptions {
	limit?: number;
}

export interface GraphQueryAnswerRoutes {
	/** Exact command that lists epic identifiers from the same graph source. */
	listEpicIdentifiers: string;
	/** Exact command that inspects a non-epic item from the same graph source. */
	showItem(identifier: string): string;
}

interface QueryScope {
	projection: LeafDependencyProjection;
	candidates: ProjectedLeaf[];
	scope: GraphQueryRef | null;
}

/**
 * A declared ancestor/descendant edge makes every dependency answer here
 * unsound: it cannot be expanded without inventing sibling blockers, and
 * ignoring it silently changes the answer (measured: `ready` reported all three
 * siblings ready and `blocked` reported nothing, with the edge still on the
 * board). Refuse rather than answer.
 */
function refuseNestedEdges(projection: LeafDependencyProjection): void {
	if (projection.nestedEdges.length > 0) throw new NestedDependencyError(projection.nestedEdges);
}

function ref(node: AtlasNode): GraphQueryRef {
	return {
		identifier: node.identifier,
		title: node.title,
		status: node.status,
		statusGroup: node.statusGroup,
		kind: node.kind,
	};
}

function refLabel(value: GraphQueryRef): string {
	return value.identifier ?? value.title;
}

function compareRefs(a: GraphQueryRef, b: GraphQueryRef): number {
	return (
		refLabel(a).localeCompare(refLabel(b), undefined, { numeric: true }) ||
		a.title.localeCompare(b.title)
	);
}

function sortByItem<T extends { item: GraphQueryRef }>(items: T[]): T[] {
	return items.sort((a, b) => compareRefs(a.item, b.item));
}

function defaultRoutes(graph: AtlasGraph): GraphQueryAnswerRoutes {
	return {
		listEpicIdentifiers: `planestories ls --json --project ${shellQuote(graph.project)} | jq -r '.availableEpics[].identifier'`,
		showItem: (identifier) =>
			`planestories show ${shellQuote(identifier)} --project ${shellQuote(graph.project)}`,
	};
}

function queryScope(
	graph: AtlasGraph,
	options: ScopedQueryOptions,
	routes?: GraphQueryAnswerRoutes,
): QueryScope {
	const projection = projectLeafDependencies(graph);
	refuseNestedEdges(projection);
	if (options.epic === undefined) {
		return { projection, candidates: [...projection.leaves.values()], scope: null };
	}

	const requested = options.epic.trim();
	if (requested.length === 0) {
		throw new ConfigError("--epic must not be blank; pass an epic identifier or omit the option.");
	}
	const answerRoutes = routes ?? defaultRoutes(graph);
	const epic = projection.nodesByIdentifier.get(requested.toUpperCase());
	if (!epic) {
		throw new ConfigError(
			`Work item ${requested} not found on board "${graph.project}". Run \`${answerRoutes.listEpicIdentifiers}\` to list epic identifiers from that same source.`,
		);
	}
	if (epic.kind !== "epic") {
		const identifier = epic.identifier ?? requested;
		throw new ConfigError(
			`${identifier} — ${epic.title} is not an epic on board "${graph.project}". Run \`${answerRoutes.showItem(identifier)}\` to inspect that work item from the same source.`,
		);
	}

	return {
		projection,
		candidates: [...projection.leaves.values()].filter((leaf) =>
			leaf.ancestors.some((ancestor) => ancestor.id === epic.id),
		),
		scope: ref(epic),
	};
}

function isOpen(leaf: ProjectedLeaf | undefined): boolean {
	return leaf !== undefined && OPEN_GROUPS.has(leaf.node.statusGroup);
}

function uniqueIds(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

function predecessorIds(projection: LeafDependencyProjection, id: string): string[] {
	return uniqueIds(projection.predecessors.get(id) ?? []);
}

function successorIds(projection: LeafDependencyProjection, id: string): string[] {
	return uniqueIds(projection.successors.get(id) ?? []);
}

function refs(ids: readonly string[], projection: LeafDependencyProjection): GraphQueryRef[] {
	return ids
		.flatMap((id) => {
			const node = projection.leaves.get(id)?.node;
			return node ? [ref(node)] : [];
		})
		.sort(compareRefs);
}

function unfinishedPredecessors(projection: LeafDependencyProjection, id: string): string[] {
	return predecessorIds(projection, id).filter(
		(blockerId) => projection.leaves.get(blockerId)?.done !== true,
	);
}

export function queryReady(
	graph: AtlasGraph,
	options: ReadyQueryOptions = {},
	routes?: GraphQueryAnswerRoutes,
): ReadyQueryReport {
	if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
		throw new ConfigError(`--limit must be a positive integer, got "${String(options.limit)}".`);
	}
	const { projection, candidates, scope } = queryScope(graph, options, routes);
	const open = candidates.filter(isOpen);
	const unknownStatus = candidates.filter((leaf) => leaf.node.statusGroup === "unknown").length;
	const items: ReadyQueryItem[] = [];

	for (const leaf of open) {
		const blockerIds = predecessorIds(projection, leaf.node.id);
		if (blockerIds.some((id) => projection.leaves.get(id)?.done !== true)) continue;

		// Rank by work THIS completion releases now, not by raw out-degree. A
		// successor with some other unfinished blocker remains constrained.
		const releasedIds = successorIds(projection, leaf.node.id).filter((targetId) => {
			if (!isOpen(projection.leaves.get(targetId))) return false;
			return predecessorIds(projection, targetId).every(
				(blockerId) =>
					blockerId === leaf.node.id || projection.leaves.get(blockerId)?.done === true,
			);
		});
		items.push({
			item: ref(leaf.node),
			blockers: refs(blockerIds, projection),
			unblocks: refs(releasedIds, projection),
		});
	}

	items.sort((a, b) => b.unblocks.length - a.unblocks.length || compareRefs(a.item, b.item));
	const matched = items.length;
	return {
		kind: "ready",
		scope,
		items: options.limit === undefined ? items : items.slice(0, options.limit),
		matched,
		openConsidered: open.length,
		unknownStatus,
	};
}

export function queryInconsistent(
	graph: AtlasGraph,
	options: ScopedQueryOptions = {},
	routes?: GraphQueryAnswerRoutes,
): InconsistentQueryReport {
	const { projection, candidates, scope } = queryScope(graph, options, routes);
	const doneWithUnfinishedBlockers: BlockedQueryItem[] = [];
	const notStartedWithDoneBlockers: BlockedQueryItem[] = [];

	for (const leaf of candidates) {
		const blockerIds = predecessorIds(projection, leaf.node.id);
		const unfinishedIds = unfinishedPredecessors(projection, leaf.node.id);
		if (leaf.node.statusGroup === "completed" && unfinishedIds.length > 0) {
			doneWithUnfinishedBlockers.push({
				item: ref(leaf.node),
				blockers: refs(unfinishedIds, projection),
			});
		}
		if (
			NOT_STARTED_GROUPS.has(leaf.node.statusGroup) &&
			blockerIds.length > 0 &&
			unfinishedIds.length === 0
		) {
			notStartedWithDoneBlockers.push({
				item: ref(leaf.node),
				blockers: refs(blockerIds, projection),
			});
		}
	}

	return {
		kind: "inconsistent",
		scope,
		doneWithUnfinishedBlockers: sortByItem(doneWithUnfinishedBlockers),
		notStartedWithDoneBlockers: sortByItem(notStartedWithDoneBlockers),
		considered: candidates.length,
		unknownStatus: candidates.filter((leaf) => leaf.node.statusGroup === "unknown").length,
	};
}

export function queryBlocked(
	graph: AtlasGraph,
	options: ScopedQueryOptions = {},
	routes?: GraphQueryAnswerRoutes,
): BlockedQueryReport {
	const { projection, candidates, scope } = queryScope(graph, options, routes);
	const open = candidates.filter(isOpen);
	const items = open.flatMap((leaf) => {
		const unfinishedIds = unfinishedPredecessors(projection, leaf.node.id);
		return unfinishedIds.length > 0
			? [{ item: ref(leaf.node), blockers: refs(unfinishedIds, projection) }]
			: [];
	});

	return {
		kind: "blocked",
		scope,
		items: sortByItem(items),
		openConsidered: open.length,
		unknownStatus: candidates.filter((leaf) => leaf.node.statusGroup === "unknown").length,
	};
}

export function queryOrphans(graph: AtlasGraph): OrphansQueryReport {
	const projection = projectLeafDependencies(graph);
	refuseNestedEdges(projection);
	const items = [...projection.leaves.values()]
		.filter((leaf) => !projection.connected.has(leaf.node.id))
		.map((leaf) => ({ item: ref(leaf.node) }));
	return { kind: "orphans", items: sortByItem(items), considered: projection.leaves.size };
}

export function queryAbandoned(graph: AtlasGraph): AbandonedQueryReport {
	// NO nested-edge refusal here, unlike its neighbours. `abandoned` reads
	// hierarchy and ancestor STATUS only — a malformed dependency edge cannot
	// change which open items sit under a cancelled epic. Refusing anyway removed
	// an exact and useful report for a reason that does not apply to it.
	//
	// `orphans` keeps the refusal: its definition is connectivity, so a dropped
	// edge is exactly what would make an item look unconnected.
	const projection = projectLeafDependencies(graph);
	const leaves = [...projection.leaves.values()];
	const open = leaves.filter(isOpen);
	const items: AbandonedQueryItem[] = [];

	for (const leaf of open) {
		const parent = [...leaf.ancestors]
			.reverse()
			.find((ancestor) => ancestor.statusGroup === "cancelled");
		if (parent) items.push({ item: ref(leaf.node), parent: ref(parent) });
	}

	return {
		kind: "abandoned",
		items: sortByItem(items),
		openConsidered: open.length,
		unknownStatus: leaves.filter((leaf) => leaf.node.statusGroup === "unknown").length,
	};
}
