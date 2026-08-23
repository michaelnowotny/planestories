import { describe, expect, test } from "bun:test";
import { PHYSICS, settleLayout } from "../../../src/atlas/layout.ts";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import { renderAtlasHtml } from "../../../src/atlas/render.ts";

function node(id: string, kind: "epic" | "story", children: AtlasNode[] = []): AtlasNode {
	return {
		id,
		kind,
		title: `Node ${id}`,
		identifier: id.toUpperCase(),
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
		children,
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

const BOARD = graph(
	[
		node("e1", "epic", [node("a", "story"), node("b", "story"), node("c", "story")]),
		node("e2", "epic", [node("d", "story"), node("f", "story")]),
	],
	[{ source: "a", target: "d", type: "blocks" }],
);

describe("pre-settled layout", () => {
	test("places every node at a finite, non-collapsed position", () => {
		const pos = settleLayout(BOARD);
		expect(Object.keys(pos)).toHaveLength(7);
		for (const p of Object.values(pos)) {
			expect(Number.isFinite(p.x)).toBe(true);
			expect(Number.isFinite(p.y)).toBe(true);
		}
		// Nodes must actually separate — a layout that collapses to the origin would
		// be "settled" and useless.
		const xs = Object.values(pos).map((p) => p.x);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
	});

	test("is DETERMINISTIC — an unchanged board renders a byte-identical file", () => {
		// The shipped physics nudges coincident nodes with Math.random(); that would
		// make every regeneration differ and destroy diff-stability, so the settle
		// uses a fixed nudge instead.
		expect(settleLayout(BOARD)).toEqual(settleLayout(BOARD));
		expect(renderAtlasHtml(BOARD, { coverage: { kind: "complete" } })).toBe(
			renderAtlasHtml(BOARD, { coverage: { kind: "complete" } }),
		);
	});

	test("an empty graph settles to nothing rather than throwing", () => {
		expect(settleLayout(graph([]))).toEqual({});
	});
});

describe("the renderer ships the settled layout", () => {
	test("embeds POS0 for every node and starts the simulation COLD", () => {
		const html = renderAtlasHtml(BOARD, { coverage: { kind: "complete" } });
		const match = html.match(/const POS0 = (\{[\s\S]*?\});\n/);
		expect(match).not.toBeNull();
		const pos = JSON.parse((match?.[1] as string).replace(/\\u003c/g, "<"));
		expect(Object.keys(pos)).toHaveLength(7);

		// The load-bearing line: without a cold start the browser still runs 325
		// ticks at one per frame, which is the entire defect.
		expect(html).toContain("PRESETTLED?AMIN*0.5:1");
		// And PRESETTLED must require EVERY node, not merely some: a partial set
		// would freeze the nodes it has while the rest fly around them.
		expect(html).toContain("NODES.every(n=>POS0[n.id])");
	});

	test("the embedded physics are the SAME constants the generator settled with", () => {
		// The whole point of interpolating PHYSICS. If the browser reheats with
		// different numbers than the pre-settled positions were produced under, a
		// drag drops the board into a world it never inhabited — and the failure is
		// silent. An earlier version of this claim was written in a comment while
		// render.ts still carried its own literals; this test is what makes it true.
		const html = renderAtlasHtml(BOARD, { coverage: { kind: "complete" } });
		expect(html).toContain(`const REP=${PHYSICS.REP},`);
		expect(html).toContain(`parent:${PHYSICS.SPRING.parent}`);
		expect(html).toContain(`blocks:${PHYSICS.REST.blocks}`);
		expect(html).toContain(`GRAV=${PHYSICS.GRAV}`);
		expect(html).toContain(`DECAY=${PHYSICS.DECAY}`);
		expect(html).toContain(`AMIN=${PHYSICS.AMIN}`);
	});

	test("an empty board still produces a valid page", () => {
		const html = renderAtlasHtml(graph([]), { coverage: { kind: "complete" } });
		expect(html).toContain("const POS0 = {}");
		expect(html).toContain("<!doctype html>");
	});
});
