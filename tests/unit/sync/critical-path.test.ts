import { describe, expect, test } from "bun:test";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import { computeCriticalPath } from "../../../src/sync/critical_path.ts";

function story(
	id: string,
	identifier: string,
	effortDays: number | null,
	overrides: Partial<AtlasNode> = {},
): AtlasNode {
	return {
		id,
		kind: "story",
		title: `Story ${identifier}`,
		identifier,
		url: null,
		status: "Todo",
		statusGroup: "unstarted",
		labels: [],
		assignee: null,
		effortDays,
		priority: null,
		criteria: [],
		quality: null,
		children: [],
		...overrides,
	} as AtlasNode;
}

function graph(nodes: AtlasNode[], edges: AtlasEdge[]): AtlasGraph {
	return {
		project: "P",
		source: "file",
		nodes,
		edges,
		labels: [],
		assignees: [],
		statuses: [],
		counts: { epics: 0, stories: nodes.length, criteria: 0, flagged: 0, edges: edges.length },
	} as AtlasGraph;
}

/** a(2) -> b(3) -> d(1) is 6 days; a(2) -> c(1) is the shorter branch. */
const CHAIN = graph(
	[story("a", "P-1", 2), story("b", "P-2", 3), story("c", "P-3", 1), story("d", "P-4", 1)],
	[
		{ source: "a", target: "b", type: "blocks" },
		{ source: "a", target: "c", type: "blocks" },
		{ source: "b", target: "d", type: "blocks" },
	],
);

describe("critical path", () => {
	test("finds the LONGEST chain, not merely a path", () => {
		const result = computeCriticalPath(CHAIN);
		expect(result.chain.map((n) => n.identifier)).toEqual(["P-1", "P-2", "P-4"]);
		expect(result.totalDays).toBe(6);
		expect(result.isLowerBound).toBe(false);
	});

	test("slack distinguishes the constrained work from the rest", () => {
		const result = computeCriticalPath(CHAIN);
		// P-3 sits on the short branch: it can slip 3 days without moving the end.
		expect(result.slackByIdentifier["P-3"]).toBe(3);
		// Chain members have none — that is what makes them critical.
		expect(result.slackByIdentifier["P-1"]).toBe(0);
		expect(result.slackByIdentifier["P-2"]).toBe(0);
	});

	test("the biggest lever is the largest item ON the chain, not on the board", () => {
		// P-9 is bigger than anything on the chain but has slack, so finishing it
		// changes the floor by nothing. That distinction is the whole point.
		const result = computeCriticalPath(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 3), story("x", "P-9", 50)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		expect(result.biggestLever?.identifier).toBe("P-2");
		expect(result.biggestLever?.daysSaved).toBe(3);
	});

	test("UNESTIMATED work makes the total an explicit lower bound", () => {
		const result = computeCriticalPath(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", null)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		// The arithmetic uses 0 for the unknown, which is only honest because the
		// result says so. A bare "2 days" here would be a fabricated certainty.
		expect(result.totalDays).toBe(2);
		expect(result.unestimatedOnChain).toBe(1);
		expect(result.isLowerBound).toBe(true);
	});

	test("finished work is free, and needs no estimate to be certain", () => {
		const done = { statusGroup: "completed" as const, status: "Done" };
		const result = computeCriticalPath(
			graph(
				[story("a", "P-1", 5, done), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		// A completed blocker blocks nothing: 3 remaining, not 8.
		expect(result.totalDays).toBe(3);
		expect(result.doneLeaves).toBe(1);
		// It carried an estimate, but even without one it would not be "unknown".
		const noEstimate = computeCriticalPath(
			graph(
				[story("a", "P-1", null, done), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		expect(noEstimate.isLowerBound).toBe(false);
	});

	test("a CYCLE refuses to produce a number", () => {
		// Exactly the shape the relation defect wrote onto the live board.
		const result = computeCriticalPath(
			graph(
				[story("a", "DATA-2569", 2), story("b", "DATA-2570", 3)],
				[
					{ source: "a", target: "b", type: "blocks" },
					{ source: "b", target: "a", type: "blocks" },
				],
			),
		);
		expect(result.cycles.length).toBe(1);
		expect(result.cycles[0]).toContain("DATA-2569");
		expect(result.cycles[0]).toContain("DATA-2570");
		// And every other field is at its empty value — a longest path through a
		// cycle is not a longer estimate, it is a meaningless one.
		expect(result.chain).toEqual([]);
		expect(result.totalDays).toBe(0);
		expect(result.biggestLever).toBeNull();
	});

	test("`relates` edges carry no ordering and must not constrain", () => {
		const result = computeCriticalPath(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "relates" }],
			),
		);
		expect(result.connectedLeaves).toBe(0);
		expect(result.chain).toEqual([]);
	});

	test("epics are containers: their children carry the duration, not them", () => {
		const epic: AtlasNode = {
			...story("e", "P-0", 999),
			kind: "epic",
			children: [story("a", "P-1", 2), story("b", "P-2", 3)],
		} as AtlasNode;
		const result = computeCriticalPath(
			graph([epic], [{ source: "a", target: "b", type: "blocks" }]),
		);
		// 5, not 1004 — counting the epic would double-count its own children.
		expect(result.totalDays).toBe(5);
		expect(result.consideredLeaves).toBe(2);
	});

	test("an unconnected board yields an empty result, distinguishable from a cycle", () => {
		const result = computeCriticalPath(graph([story("a", "P-1", 2)], []));
		expect(result.chain).toEqual([]);
		expect(result.cycles).toEqual([]);
		expect(result.consideredLeaves).toBe(1);
	});
});
