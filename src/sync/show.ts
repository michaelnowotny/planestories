import type { AtlasGraph, AtlasNode, DependencyCoverage } from "../atlas/model.ts";
import { ConfigError } from "../errors.ts";
import { formatDevDays } from "../markdown/directives.ts";

export interface ShowRelationRef {
	identifier: string | null;
	title: string;
	status: string | null;
}

export interface ShowItem {
	identifier: string;
	title: string;
	status: string | null;
	effortDays: number | null;
	priority: string | null;
	assignee: string | null;
	labels: string[];
	parent: { identifier: string | null; title: string } | null;
	directChildren: {
		total: number;
		byStatus: Array<{ status: string | null; count: number }>;
	};
	relations: {
		blockedBy: ShowRelationRef[];
		blocks: ShowRelationRef[];
		relatesTo: ShowRelationRef[];
	};
	criteria: { completed: number; total: number };
	dependencyCoverage: DependencyCoverage;
}

interface LocatedNode {
	node: AtlasNode;
	parent: AtlasNode | null;
}

function indexGraph(graph: AtlasGraph): {
	byId: Map<string, LocatedNode>;
	byIdentifier: Map<string, LocatedNode>;
} {
	const byId = new Map<string, LocatedNode>();
	const byIdentifier = new Map<string, LocatedNode>();
	const walk = (nodes: AtlasNode[], parent: AtlasNode | null): void => {
		for (const node of nodes) {
			const located = { node, parent };
			byId.set(node.id, located);
			if (node.identifier) byIdentifier.set(node.identifier.trim().toUpperCase(), located);
			walk(node.children, node);
		}
	};
	walk(graph.nodes, null);
	return { byId, byIdentifier };
}

function relationRef(node: AtlasNode): ShowRelationRef {
	return { identifier: node.identifier, title: node.title, status: node.status };
}

function sortRelationRefs(refs: ShowRelationRef[]): ShowRelationRef[] {
	return refs.sort(
		(a, b) =>
			(a.identifier ?? a.title).localeCompare(b.identifier ?? b.title) ||
			a.title.localeCompare(b.title),
	);
}

/**
 * Project one work item out of the shared Atlas graph. The graph already owns
 * the canonical hierarchy, criteria folding, and normalized dependency edges;
 * `show` must not rebuild any of those from a second board-reading path.
 */
export function buildShowItem(
	graph: AtlasGraph,
	identifier: string,
	dependencyCoverage: DependencyCoverage,
): ShowItem {
	const indexed = indexGraph(graph);
	const located = indexed.byIdentifier.get(identifier.trim().toUpperCase());
	if (!located) {
		throw new ConfigError(`Work item ${identifier} not found on board "${graph.project}".`);
	}

	const statusCounts = new Map<string | null, number>();
	for (const child of located.node.children) {
		statusCounts.set(child.status, (statusCounts.get(child.status) ?? 0) + 1);
	}
	const byStatus = [...statusCounts.entries()]
		.map(([status, count]) => ({ status, count }))
		.sort((a, b) => {
			if (a.status === null) return b.status === null ? 0 : 1;
			if (b.status === null) return -1;
			return a.status.localeCompare(b.status);
		});

	const blockedBy: ShowRelationRef[] = [];
	const blocks: ShowRelationRef[] = [];
	const relatesTo: ShowRelationRef[] = [];
	for (const edge of graph.edges) {
		if (edge.type === "blocks") {
			if (edge.target === located.node.id) {
				const counterpart = indexed.byId.get(edge.source)?.node;
				if (counterpart) blockedBy.push(relationRef(counterpart));
			} else if (edge.source === located.node.id) {
				const counterpart = indexed.byId.get(edge.target)?.node;
				if (counterpart) blocks.push(relationRef(counterpart));
			}
		} else if (edge.source === located.node.id || edge.target === located.node.id) {
			const counterpartId = edge.source === located.node.id ? edge.target : edge.source;
			const counterpart = indexed.byId.get(counterpartId)?.node;
			if (counterpart) relatesTo.push(relationRef(counterpart));
		}
	}

	return {
		identifier: located.node.identifier as string,
		title: located.node.title,
		status: located.node.status,
		effortDays: located.node.effortDays,
		priority: located.node.priority,
		assignee: located.node.assignee,
		labels: [...located.node.labels],
		parent: located.parent
			? { identifier: located.parent.identifier, title: located.parent.title }
			: null,
		directChildren: { total: located.node.children.length, byStatus },
		relations: {
			blockedBy: sortRelationRefs(blockedBy),
			blocks: sortRelationRefs(blocks),
			relatesTo: sortRelationRefs(relatesTo),
		},
		criteria: {
			completed: located.node.criteria.filter((criterion) => criterion.checked).length,
			total: located.node.criteria.length,
		},
		dependencyCoverage,
	};
}

function display(value: string | null): string {
	return value ?? "unset";
}

function formatRef(kind: string, ref: ShowRelationRef): string {
	return `${kind} ${ref.identifier ?? "(unlinked)"} — ${ref.title} [${ref.status ?? "unknown status"}]`;
}

function renderRelations(item: ShowItem): string {
	if (item.dependencyCoverage.kind === "skipped") return "Relations: not fetched";
	const refs = [
		...item.relations.blockedBy.map((ref) => formatRef("blocked by", ref)),
		...item.relations.blocks.map((ref) => formatRef("blocks", ref)),
		...item.relations.relatesTo.map((ref) => formatRef("related to", ref)),
	];
	const qualifier =
		item.dependencyCoverage.kind === "partial"
			? ` (partial: ${item.dependencyCoverage.failures} lookup${item.dependencyCoverage.failures === 1 ? "" : "s"} failed)`
			: "";
	return `Relations${qualifier}: ${refs.length > 0 ? refs.join("; ") : item.dependencyCoverage.kind === "partial" ? "none observed" : "none"}`;
}

/** Render the deliberately shallow, screen-sized human answer. */
export function renderShowText(item: ShowItem, provenance: string): string {
	const effort = item.effortDays === null ? "unset" : `${formatDevDays(item.effortDays)} dev-days`;
	const parent = item.parent
		? `${item.parent.identifier ?? "(unlinked)"} — ${item.parent.title}`
		: "none";
	const childSplit = item.directChildren.byStatus
		.map(({ status, count }) => `${status ?? "unknown"} ${count}`)
		.join(", ");
	const children =
		item.directChildren.total === 0 ? "0" : `${item.directChildren.total} (${childSplit})`;

	return [
		`${item.identifier} — ${item.title}`,
		`Status: ${display(item.status)} · Effort: ${effort} · Priority: ${display(item.priority)} · Assignee: ${display(item.assignee)}`,
		`Labels: ${item.labels.length > 0 ? item.labels.join(", ") : "none"} · Parent: ${parent}`,
		`Children: ${children} · Criteria: ${item.criteria.completed} of ${item.criteria.total}`,
		renderRelations(item),
		`Source: ${provenance}`,
	].join("\n");
}
