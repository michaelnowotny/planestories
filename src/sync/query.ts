import type { AtlasGraph, AtlasNode, StatusGroup } from "../atlas/model.ts";
import { ConfigError } from "../errors.ts";
import { formatDevDays } from "../markdown/directives.ts";
import { shellQuote } from "../utils/shell.ts";
import {
	NestedDependencyError,
	type ProjectedLeaf,
	projectLeafDependencies,
} from "./critical_path.ts";
import { requirementForStoryPredicates } from "./query_requirements.ts";

export interface QueryPredicates {
	open?: boolean;
	status?: string;
	label?: string;
	assignee?: string;
	epic?: string;
	flagged?: boolean;
	noEstimate?: boolean;
	blocked?: boolean;
}

export type QueryGroupBy = "status" | "assignee" | "label" | "epic";

export interface QueryEpicRef {
	identifier: string | null;
	title: string;
}

/** The deliberately shallow row emitted by `ls`; no description body is copied. */
export interface QueryItem {
	identifier: string | null;
	title: string;
	status: string | null;
	statusGroup: StatusGroup;
	labels: string[];
	assignee: string | null;
	effortDays: number | null;
	priority: string | null;
	url: string | null;
	/** Null means quality was not assessed; it is not coerced into a clean bill. */
	flagged: boolean | null;
	/** Nearest structural epic, or null for a standalone story. */
	epic: QueryEpicRef | null;
}

export interface StoryQueryResult {
	items: QueryItem[];
	count: number;
	/** Leaf stories in the selected board/epic scope, before predicates narrow it. */
	denominator: number;
	predicates: QueryPredicates;
	scopeEpic: QueryEpicRef | null;
	/** Named structural epics, so a missing --epic refusal can list valid identifiers. */
	availableEpics: QueryEpicRef[];
}

export interface QueryGroup {
	/** Null is an explicit unassigned/unlabelled/no-epic/unknown-status bucket. */
	value: string | null;
	count: number;
	/** Every group count is quotable with its selected-set denominator. */
	denominator: number;
}

export interface QueryAnswerRoutes {
	/** Exact command that lists epic identifiers from the same source/board. */
	listEpicIdentifiers: string;
	/** Exact command that inspects one item from the same source/board. */
	showItem(identifier: string): string;
}

function nearestEpic(leaf: ProjectedLeaf): AtlasNode | null {
	return leaf.ancestors.at(-1) ?? null;
}

function epicRef(node: AtlasNode | null): QueryEpicRef | null {
	return node ? { identifier: node.identifier, title: node.title } : null;
}

function queryItem(leaf: ProjectedLeaf): QueryItem {
	const node = leaf.node;
	return {
		identifier: node.identifier,
		title: node.title,
		status: node.status,
		statusGroup: node.statusGroup,
		labels: [...node.labels],
		assignee: node.assignee,
		effortDays: node.effortDays,
		priority: node.priority,
		url: node.url,
		flagged: node.quality === null ? null : !node.quality.ok,
		epic: epicRef(nearestEpic(leaf)),
	};
}

function equalsFolded(actual: string | null, expected: string): boolean {
	return actual !== null && actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

export function validateQueryPredicates(predicates: QueryPredicates): void {
	for (const [name, value] of [
		["--status", predicates.status],
		["--label", predicates.label],
		["--assignee", predicates.assignee],
		["--epic", predicates.epic],
	] as const) {
		if (value !== undefined && value.trim().length === 0) {
			throw new ConfigError(
				`${name} must not be blank; pass a concrete value or omit the predicate.`,
			);
		}
	}
}

function matchesPredicates(
	leaf: ProjectedLeaf,
	item: QueryItem,
	predicates: QueryPredicates,
	activelyBlocked: ReadonlySet<string>,
): boolean {
	if (predicates.open && leaf.done) return false;
	if (predicates.status && !equalsFolded(item.status, predicates.status)) return false;
	if (
		predicates.label &&
		!item.labels.some((label) => equalsFolded(label, predicates.label as string))
	) {
		return false;
	}
	if (predicates.assignee && !equalsFolded(item.assignee, predicates.assignee)) return false;
	if (predicates.flagged && item.flagged !== true) return false;
	if (predicates.noEstimate && item.effortDays !== null) return false;
	if (predicates.blocked && !activelyBlocked.has(leaf.node.id)) return false;
	return true;
}

/**
 * Apply the fixed local-query predicates with AND semantics.
 *
 * The epic predicate establishes the denominator (all descendant leaf stories);
 * every other predicate narrows the numerator. `--blocked` callers must first
 * obtain the graph via `requireCompleteGraph`, since this pure function cannot
 * know whether an AtlasGraph's absent edges were observed or merely skipped.
 */
export function queryStories(
	graph: AtlasGraph,
	predicates: QueryPredicates,
	routes?: QueryAnswerRoutes,
): StoryQueryResult {
	validateQueryPredicates(predicates);
	const projection = projectLeafDependencies(graph);
	const requirement = requirementForStoryPredicates(predicates);
	// `--blocked` is the one predicate here that reads RELATIONS, and a nested
	// ancestor/descendant edge is never written into `predecessors` — so without
	// this, `ls --blocked` quietly OMITS an item the board says is blocked and
	// `count --blocked` returns a number that is too small. The dependency verbs
	// refuse; these two were the sixth path and were missed.
	//
	// Scoped to `--blocked` deliberately: refusing every `ls` because one edge is
	// malformed would decline questions that do not depend on it.
	if (requirement.relations === "required" && projection.nestedEdges.length > 0) {
		throw new NestedDependencyError(projection.nestedEdges);
	}
	const answerRoutes: QueryAnswerRoutes =
		routes ??
		({
			listEpicIdentifiers: `planestories ls --json --project ${shellQuote(graph.project)} | jq -r '.availableEpics[].identifier'`,
			showItem: (identifier) =>
				`planestories show ${shellQuote(identifier)} --project ${shellQuote(graph.project)}`,
		} satisfies QueryAnswerRoutes);
	let selectedEpic: AtlasNode | null = null;
	if (predicates.epic) {
		const requested = predicates.epic.trim();
		selectedEpic = projection.nodesByIdentifier.get(requested.toUpperCase()) ?? null;
		if (!selectedEpic) {
			throw new ConfigError(
				`Work item ${requested} not found on board "${graph.project}". Run \`${answerRoutes.listEpicIdentifiers}\` to list epic identifiers from that same source.`,
			);
		}
		if (selectedEpic.kind !== "epic") {
			const identifier = selectedEpic.identifier ?? requested;
			throw new ConfigError(
				`${identifier} is not an epic on board "${graph.project}". Run \`${answerRoutes.showItem(identifier)}\` to inspect that work item from the same source.`,
			);
		}
	}

	const scope = [...projection.leaves.values()].filter(
		(leaf) => !selectedEpic || leaf.ancestors.some((ancestor) => ancestor.id === selectedEpic?.id),
	);
	const activelyBlocked = new Set<string>();
	for (const leaf of scope) {
		if (leaf.done) continue;
		const hasActiveBlocker = (projection.predecessors.get(leaf.node.id) ?? []).some((id) => {
			const blocker = projection.leaves.get(id);
			return blocker !== undefined && !blocker.done;
		});
		if (hasActiveBlocker) activelyBlocked.add(leaf.node.id);
	}

	const items = scope
		.filter((leaf) => {
			const item = queryItem(leaf);
			return matchesPredicates(leaf, item, predicates, activelyBlocked);
		})
		.map(queryItem);
	const availableEpics = [...projection.nodesByIdentifier.values()]
		.filter((node) => node.kind === "epic" && node.identifier !== null)
		.map((node) => ({ identifier: node.identifier, title: node.title }));

	return {
		items,
		count: items.length,
		denominator: scope.length,
		predicates: { ...predicates },
		scopeEpic: epicRef(selectedEpic),
		availableEpics,
	};
}

function groupValues(item: QueryItem, groupBy: QueryGroupBy): Array<string | null> {
	if (groupBy === "status") return [item.status];
	if (groupBy === "assignee") return [item.assignee];
	if (groupBy === "epic") return [item.epic?.identifier ?? null];
	return item.labels.length > 0 ? [...new Set(item.labels)] : [null];
}

/** Group selected rows; label groups may overlap because a story can carry several labels. */
export function groupQueryItems(items: QueryItem[], groupBy: QueryGroupBy): QueryGroup[] {
	const counts = new Map<string | null, number>();
	for (const item of items) {
		for (const value of groupValues(item, groupBy)) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort(([a], [b]) => {
			if (a === null) return b === null ? 0 : 1;
			if (b === null) return -1;
			return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
		})
		.map(([value, count]) => ({ value, count, denominator: items.length }));
}

function predicateDescription(predicates: QueryPredicates): string | null {
	const active = [
		predicates.open ? "open" : null,
		predicates.status ? `with status ${predicates.status}` : null,
		predicates.label ? `with label ${predicates.label}` : null,
		predicates.assignee ? `assigned to ${predicates.assignee}` : null,
		predicates.flagged ? "flagged" : null,
		predicates.noEstimate ? "without estimates" : null,
		predicates.blocked ? "blocked" : null,
	].filter((value): value is string => value !== null);
	if (active.length === 0) return null;
	if (active.length === 1) return active[0] as string;
	return "matching all filters";
}

function groupLabel(groupBy: QueryGroupBy, value: string | null): string {
	if (value !== null) return value;
	if (groupBy === "assignee") return "unassigned";
	if (groupBy === "label") return "unlabelled";
	if (groupBy === "epic") return "no epic";
	return "unknown status";
}

/** Human count output. Every numeric claim includes its denominator. */
export function renderCountText(
	result: StoryQueryResult,
	groups: QueryGroup[],
	groupBy?: QueryGroupBy,
): string {
	const description = predicateDescription(result.predicates);
	const count = description ? `${result.count} ${description}` : `${result.count} stories`;
	const scope = result.scopeEpic?.identifier ? ` in ${result.scopeEpic.identifier}` : "";
	const lines = [`${count} of ${result.denominator} stories${scope}`];
	if (groups.length > 0) {
		lines.push("");
		for (const group of groups) {
			const label = groupBy ? groupLabel(groupBy, group.value) : (group.value ?? "unknown");
			lines.push(`  ${label}: ${group.count} of ${group.denominator}`);
		}
	}
	return lines.join("\n");
}

/** Human list output; missing values are named, never rendered as valid-looking zeroes. */
export function renderListText(result: StoryQueryResult): string {
	const lines = result.items.map((item) => {
		const effort = item.effortDays === null ? "no estimate" : `${formatDevDays(item.effortDays)}d`;
		return [
			item.identifier ?? "(unlinked)",
			item.status ?? "unknown status",
			item.assignee ?? "unassigned",
			effort,
			item.title,
		].join(" · ");
	});
	if (lines.length === 0) lines.push("No stories match all selected predicates.");
	lines.push("");
	lines.push(
		`${result.count} ${result.count === 1 ? "match" : "matches"} of ${result.denominator} stories in scope`,
	);
	return lines.join("\n");
}
