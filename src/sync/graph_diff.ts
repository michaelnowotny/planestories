import type { AtlasGraph, AtlasNode } from "../atlas/model.ts";

/**
 * Structural diff between two board graphs.
 *
 * Answers "what changed on the board?" in the vocabulary you actually think in
 * — dependencies appearing and vanishing, stories moving between epics, work
 * being flagged — rather than as a JSON diff of two 5MB snapshots.
 *
 * Three rules keep it honest:
 *
 * 1. IT IS NOT A MERGE TOOL. It reports difference and nothing else. There is no
 *    "apply", no direction, no notion of one side being right. Since the cutover
 *    the operator has two boards that legitimately disagree, and a tool that
 *    offered to reconcile them would be offering to destroy one.
 * 2. COMPARING ACROSS INSTANCES IS A DIFFERENT QUESTION, and the result says so.
 *    Two snapshots of the SAME board a week apart show change over time; a cloud
 *    snapshot against a CE one shows divergence between replicas. The numbers
 *    look identical and mean different things, so the caller is told which it
 *    got rather than left to assume.
 * 3. IDENTITY IS THE HUMAN IDENTIFIER, never the internal id. Replication mints
 *    new UUIDs for everything, so a UUID-keyed diff of two instances reports
 *    that every single item was deleted and re-created. Identifiers survive;
 *    that is the whole premise of the replication engine.
 */

export interface EdgeChange {
	/** "DATA-1 blocks DATA-2" — both ends by identifier. */
	from: string;
	to: string;
	type: "blocks" | "relates";
}

export interface FieldChange {
	identifier: string;
	title: string;
	field: "status" | "epic" | "effortDays" | "flagged" | "title";
	before: string | null;
	after: string | null;
}

export interface GraphDiff {
	/** True when both sides came from the same workspace — change over TIME. */
	sameInstance: boolean;
	before: { label: string; instance: string; stories: number; edges: number };
	after: { label: string; instance: string; stories: number; edges: number };
	addedStories: Array<{ identifier: string; title: string }>;
	removedStories: Array<{ identifier: string; title: string }>;
	addedEdges: EdgeChange[];
	removedEdges: EdgeChange[];
	changes: FieldChange[];
}

interface Flat {
	byIdentifier: Map<string, AtlasNode>;
	epicOf: Map<string, string>;
	edges: EdgeChange[];
}

function flatten(graph: AtlasGraph): Flat {
	const byIdentifier = new Map<string, AtlasNode>();
	const idToIdentifier = new Map<string, string>();
	const epicOf = new Map<string, string>();

	const walk = (nodes: AtlasNode[], epic: AtlasNode | null): void => {
		for (const n of nodes) {
			// Unlinked nodes have no identifier and therefore no stable identity
			// across snapshots — including them would manufacture add/remove pairs.
			if (n.identifier) {
				byIdentifier.set(n.identifier, n);
				idToIdentifier.set(n.id, n.identifier);
				if (epic?.identifier && n.kind !== "epic") epicOf.set(n.identifier, epic.identifier);
			}
			walk(n.children ?? [], n.kind === "epic" ? n : epic);
		}
	};
	walk(graph.nodes, null);

	const edges: EdgeChange[] = [];
	for (const e of graph.edges) {
		const from = idToIdentifier.get(e.source);
		const to = idToIdentifier.get(e.target);
		if (!from || !to) continue;
		// "relates" is undirected: order the ends so the same edge from either
		// side is one edge, not two.
		if (e.type === "relates") {
			const [a, b] = [from, to].sort();
			edges.push({ from: a as string, to: b as string, type: "relates" });
		} else {
			edges.push({ from, to, type: "blocks" });
		}
	}
	return { byIdentifier, epicOf, edges };
}

const edgeKey = (e: EdgeChange) => `${e.type}:${e.from}>${e.to}`;
const flaggedOf = (n: AtlasNode) => (n.quality ? (n.quality.ok ? "clean" : "flagged") : null);

export function diffGraphs(
	before: AtlasGraph,
	after: AtlasGraph,
	meta: {
		beforeLabel: string;
		afterLabel: string;
		beforeInstance: string;
		afterInstance: string;
	},
): GraphDiff {
	const a = flatten(before);
	const b = flatten(after);

	const addedStories: GraphDiff["addedStories"] = [];
	const removedStories: GraphDiff["removedStories"] = [];
	for (const [identifier, node] of b.byIdentifier) {
		if (!a.byIdentifier.has(identifier)) addedStories.push({ identifier, title: node.title });
	}
	for (const [identifier, node] of a.byIdentifier) {
		if (!b.byIdentifier.has(identifier)) removedStories.push({ identifier, title: node.title });
	}

	const aEdges = new Map(a.edges.map((e) => [edgeKey(e), e]));
	const bEdges = new Map(b.edges.map((e) => [edgeKey(e), e]));
	const addedEdges = [...bEdges].filter(([k]) => !aEdges.has(k)).map(([, e]) => e);
	const removedEdges = [...aEdges].filter(([k]) => !bEdges.has(k)).map(([, e]) => e);

	// Field changes only for items present on BOTH sides. A field "changing" on an
	// item that was added or removed is not a change, it is the add or the remove.
	const changes: FieldChange[] = [];
	for (const [identifier, next] of b.byIdentifier) {
		const prev = a.byIdentifier.get(identifier);
		if (!prev) continue;
		const push = (field: FieldChange["field"], before2: string | null, after2: string | null) => {
			if (before2 !== after2)
				changes.push({ identifier, title: next.title, field, before: before2, after: after2 });
		};
		push("status", prev.status, next.status);
		push("epic", a.epicOf.get(identifier) ?? null, b.epicOf.get(identifier) ?? null);
		// null vs 0 must stay distinguishable: "no estimate" and "estimated at
		// zero" are different states and the diff must not collapse them.
		push(
			"effortDays",
			prev.effortDays === null ? null : String(prev.effortDays),
			next.effortDays === null ? null : String(next.effortDays),
		);
		push("flagged", flaggedOf(prev), flaggedOf(next));
		push("title", prev.title, next.title);
	}

	const count = (g: AtlasGraph, f: Flat) => ({
		stories: f.byIdentifier.size,
		edges: g.edges.length,
	});

	return {
		sameInstance: meta.beforeInstance === meta.afterInstance,
		before: { label: meta.beforeLabel, instance: meta.beforeInstance, ...count(before, a) },
		after: { label: meta.afterLabel, instance: meta.afterInstance, ...count(after, b) },
		addedStories: addedStories.sort((x, y) => x.identifier.localeCompare(y.identifier)),
		removedStories: removedStories.sort((x, y) => x.identifier.localeCompare(y.identifier)),
		addedEdges: addedEdges.sort((x, y) => edgeKey(x).localeCompare(edgeKey(y))),
		removedEdges: removedEdges.sort((x, y) => edgeKey(x).localeCompare(edgeKey(y))),
		changes: changes.sort(
			(x, y) => x.identifier.localeCompare(y.identifier) || x.field.localeCompare(y.field),
		),
	};
}

const arrow = (e: EdgeChange) =>
	e.type === "blocks" ? `${e.from} → ${e.to}` : `${e.from} ↔ ${e.to}`;

export function formatGraphDiff(d: GraphDiff): string {
	const lines: string[] = [];
	lines.push(`${d.before.label}  →  ${d.after.label}`);
	lines.push(
		`  ${d.before.stories} stories / ${d.before.edges} edges   →   ${d.after.stories} stories / ${d.after.edges} edges`,
	);
	if (!d.sameInstance) {
		// The same numbers mean a different thing here, so say which thing.
		lines.push("");
		lines.push(
			`  ⚠ DIFFERENT INSTANCES (${d.before.instance} vs ${d.after.instance}): this is DIVERGENCE`,
		);
		lines.push("    between two boards, not change over time. Neither side is authoritative and");
		lines.push("    nothing here reconciles them — this reports difference only.");
	}
	lines.push("");

	const section = (title: string, rows: string[]) => {
		if (rows.length === 0) return;
		lines.push(`${title} (${rows.length})`);
		for (const r of rows.slice(0, 40)) lines.push(`  ${r}`);
		if (rows.length > 40) lines.push(`  … and ${rows.length - 40} more`);
		lines.push("");
	};

	section("Dependencies ADDED", d.addedEdges.map(arrow));
	section("Dependencies REMOVED", d.removedEdges.map(arrow));
	section(
		"Stories ADDED",
		d.addedStories.map((s) => `${s.identifier}  ${s.title.slice(0, 60)}`),
	);
	section(
		"Stories REMOVED",
		d.removedStories.map((s) => `${s.identifier}  ${s.title.slice(0, 60)}`),
	);
	section(
		"Changed",
		d.changes.map(
			(c) => `${c.identifier}  ${c.field}: ${c.before ?? "(none)"} → ${c.after ?? "(none)"}`,
		),
	);

	if (
		d.addedEdges.length === 0 &&
		d.removedEdges.length === 0 &&
		d.addedStories.length === 0 &&
		d.removedStories.length === 0 &&
		d.changes.length === 0
	) {
		lines.push("No structural difference.");
	}
	return lines.join("\n").trimEnd();
}
