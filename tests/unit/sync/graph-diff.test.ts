import { describe, expect, test } from "bun:test";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import { diffGraphs, formatGraphDiff } from "../../../src/sync/graph_diff.ts";

function story(id: string, identifier: string | null, over: Partial<AtlasNode> = {}): AtlasNode {
	return {
		id,
		kind: "story",
		title: `Story ${identifier ?? id}`,
		identifier,
		url: null,
		status: "Todo",
		statusGroup: "unstarted",
		labels: [],
		assignee: null,
		effortDays: null,
		priority: null,
		createdAt: null,
		updatedAt: null,
		criteria: [],
		quality: null,
		children: [],
		...over,
	} as AtlasNode;
}

function graph(nodes: AtlasNode[], edges: AtlasEdge[] = []): AtlasGraph {
	return {
		project: "P",
		source: "board",
		nodes,
		edges,
		labels: [],
		assignees: [],
		statuses: [],
		counts: { epics: 0, stories: 0, criteria: 0, flagged: 0, edges: edges.length },
	} as AtlasGraph;
}

const META = {
	beforeLabel: "before",
	afterLabel: "after",
	beforeInstance: "ws",
	afterInstance: "ws",
};

describe("graph diff", () => {
	test("identity is the HUMAN identifier, not the internal id", () => {
		// Replication mints new UUIDs for everything. A UUID-keyed diff of two
		// instances would report that every item was deleted and re-created —
		// which is the single thing that would make this tool useless for the
		// case it exists to serve.
		const before = graph([story("uuid-old", "DATA-1")]);
		const after = graph([story("totally-different-uuid", "DATA-1")]);
		const d = diffGraphs(before, after, META);
		expect(d.addedStories).toEqual([]);
		expect(d.removedStories).toEqual([]);
	});

	test("detects dependency edges appearing and vanishing, by identifier", () => {
		const before = graph(
			[story("a", "DATA-1"), story("b", "DATA-2")],
			[{ source: "a", target: "b", type: "blocks" }],
		);
		const after = graph(
			[story("a", "DATA-1"), story("b", "DATA-2")],
			[{ source: "b", target: "a", type: "blocks" }],
		);
		const d = diffGraphs(before, after, META);
		expect(d.removedEdges).toEqual([{ from: "DATA-1", to: "DATA-2", type: "blocks" }]);
		expect(d.addedEdges).toEqual([{ from: "DATA-2", to: "DATA-1", type: "blocks" }]);
	});

	test("an undirected relates edge is ONE edge, from either side", () => {
		const before = graph(
			[story("a", "DATA-1"), story("b", "DATA-2")],
			[{ source: "a", target: "b", type: "relates" }],
		);
		const after = graph(
			[story("a", "DATA-1"), story("b", "DATA-2")],
			[{ source: "b", target: "a", type: "relates" }],
		);
		const d = diffGraphs(before, after, META);
		expect(d.addedEdges).toEqual([]);
		expect(d.removedEdges).toEqual([]);
	});

	test("null effort and zero effort are DIFFERENT states", () => {
		// "no estimate" and "estimated at zero" must not collapse — the whole
		// lower-bound machinery depends on telling them apart.
		const before = graph([story("a", "DATA-1", { effortDays: null })]);
		const after = graph([story("a", "DATA-1", { effortDays: 0 })]);
		const d = diffGraphs(before, after, META);
		const change = d.changes.find((c) => c.field === "effortDays");
		expect(change?.before).toBeNull();
		expect(change?.after).toBe("0");
	});

	test("a field change is not reported for an ADDED or REMOVED story", () => {
		// That is the add or the remove, not a change; reporting both double-counts.
		const before = graph([story("a", "DATA-1")]);
		const after = graph([story("a", "DATA-1"), story("b", "DATA-2", { status: "Done" })]);
		const d = diffGraphs(before, after, META);
		expect(d.addedStories.map((s) => s.identifier)).toEqual(["DATA-2"]);
		expect(d.changes.filter((c) => c.identifier === "DATA-2")).toEqual([]);
	});

	test("unlinked nodes are excluded — they have no identity across snapshots", () => {
		const before = graph([story("a", null)]);
		const after = graph([story("b", null)]);
		const d = diffGraphs(before, after, META);
		expect(d.addedStories).toEqual([]);
		expect(d.removedStories).toEqual([]);
	});

	test("comparing DIFFERENT instances says so, loudly", () => {
		// Same numbers, different meaning: two snapshots of one board show change
		// over time; two boards show divergence. Since the cutover the operator has
		// two boards that legitimately disagree.
		const d = diffGraphs(graph([]), graph([]), {
			...META,
			beforeInstance: "bloomenkohlberg",
			afterInstance: "archimedes",
		});
		expect(d.sameBoard).toBe(false);
		const out = formatGraphDiff(d);
		expect(out).toContain("DIFFERENT INSTANCES");
		expect(out).toContain("DIVERGENCE");
		// It must not offer to fix anything.
		expect(out).toContain("reports difference only");
	});

	test("two HOSTS sharing a workspace slug are NOT the same instance", () => {
		// A bare workspace slug calls two different hosts one board, suppressing the
		// divergence banner in exactly the case it exists for. The CLI keys on
		// instanceTag(host, slug), the same helper trend and backup use.
		const d = diffGraphs(graph([]), graph([]), {
			...META,
			beforeInstance: "plane-so-archimedes",
			afterInstance: "plane-porcupine-works-archimedes",
		});
		expect(d.sameBoard).toBe(false);
		expect(formatGraphDiff(d)).toContain("DIVERGENCE");
	});

	test("two PROJECTS on one instance are NOT the same board", () => {
		// Otherwise diffing DATA against SBOX reports every story added and removed
		// with no explanation of why.
		const d = diffGraphs(graph([]), graph([]), {
			...META,
			beforeProject: "DATA",
			afterProject: "SBOX",
		});
		expect(d.sameBoard).toBe(false);
		// And the banner must name the difference that EXISTS. It used to print
		// "DIFFERENT INSTANCES (x vs x)" — the same string twice — in exactly this
		// case, which is the one where the reader most needs telling what they are
		// looking at. Asserting only `sameBoard` let that survive.
		const out = formatGraphDiff(d);
		expect(out).toContain("DIFFERENT PROJECTS");
		expect(out).toContain("DATA");
		expect(out).toContain("SBOX");
		expect(out).not.toContain("DIFFERENT INSTANCES");
	});

	test("same instance carries no divergence warning", () => {
		const d = diffGraphs(graph([]), graph([]), {
			...META,
			beforeProject: "DATA",
			afterProject: "DATA",
		});
		expect(d.sameBoard).toBe(true);
		expect(formatGraphDiff(d)).not.toContain("DIVERGENCE");
	});

	test("no difference says so, rather than printing empty sections", () => {
		const g = graph([story("a", "DATA-1")]);
		expect(formatGraphDiff(diffGraphs(g, g, META))).toContain("No structural difference");
	});
});
