import { describe, expect, test } from "bun:test";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import { computeCriticalPath } from "../../../src/sync/critical_path.ts";

function story(
	id: string,
	identifier: string | null,
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
		createdAt: null,
		updatedAt: null,
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

/** Compute and assert the result is a COMPUTED one (narrows the union). */
function computed(g: AtlasGraph) {
	const r = computeCriticalPath(g);
	if (!r.ok)
		throw new Error(`expected a computed result, got a refusal: ${JSON.stringify(r.cycles)}`);
	return r;
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
		const result = computed(CHAIN);
		expect(result.chain.map((n) => n.identifier)).toEqual(["P-1", "P-2", "P-4"]);
		expect(result.totalDays).toBe(6);
		expect(result.isLowerBound).toBe(false);
	});

	test("slack distinguishes the constrained work from the rest", () => {
		const result = computed(CHAIN);
		// P-3 sits on the short branch: it can slip 3 days without moving the end.
		expect(result.slackByIdentifier["P-3"]).toBe(3);
		// Chain members have none — that is what makes them critical.
		expect(result.slackByIdentifier["P-1"]).toBe(0);
		expect(result.slackByIdentifier["P-2"]).toBe(0);
	});

	test("the biggest lever is the largest item ON the chain, not on the board", () => {
		// P-9 is bigger than anything on the chain but has slack, so finishing it
		// changes the floor by nothing. That distinction is the whole point.
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 3), story("x", "P-9", 50)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		expect(result.biggestLever?.identifier).toBe("P-2");
		expect(result.biggestLever?.daysSaved).toBe(3);
	});

	test("UNESTIMATED work makes the total an explicit lower bound", () => {
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", null)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		// The arithmetic uses 0 for the unknown, which is only honest because the
		// result says so. A bare "2 days" here would be a fabricated certainty.
		expect(result.totalDays).toBe(2);
		expect(result.unestimated).toBe(1);
		expect(result.isLowerBound).toBe(true);
	});

	test("finished work is free, and needs no estimate to be certain", () => {
		const done = { statusGroup: "completed" as const, status: "Done" };
		const result = computed(
			graph(
				[story("a", "P-1", 5, done), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		// A completed blocker blocks nothing: 3 remaining, not 8.
		expect(result.totalDays).toBe(3);
		expect(result.doneLeaves).toBe(1);
		// It carried an estimate, but even without one it would not be "unknown".
		const noEstimate = computed(
			graph(
				[story("a", "P-1", null, done), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		expect(noEstimate.isLowerBound).toBe(false);
	});

	test("a zero-duration blocker remains in the reported critical chain", () => {
		const cases = [
			story("done", "P-1", 5, { statusGroup: "completed", status: "Done" }),
			story("zero", "P-1", 0),
		];
		for (const blocker of cases) {
			const result = computed(
				graph(
					[blocker, story("target", "P-2", 3)],
					[{ source: blocker.id, target: "target", type: "blocks" }],
				),
			);
			// The duration is still 3, but the chain must name the declared blocker.
			expect(result.totalDays).toBe(3);
			expect(result.chain.map((node) => node.identifier)).toEqual(["P-1", "P-2"]);
		}
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
		if (result.ok) throw new Error("expected a refusal");
		expect(result.cycles.length).toBe(1);
		expect(result.cycles[0]).toContain("DATA-2569");
		expect(result.cycles[0]).toContain("DATA-2570");
		// A refusal carries NO totalDays / chain / isLowerBound at all — there is
		// nothing for `jq .totalDays` to read as 0, which is how a fabricated
		// answer escapes into a script.
		expect(result).not.toHaveProperty("totalDays");
		expect(result).not.toHaveProperty("chain");
		expect(result).not.toHaveProperty("isLowerBound");
	});

	test("a self-blocking story is reported as a dependency cycle", () => {
		const result = computeCriticalPath(
			graph([story("a", "DATA-1", 2)], [{ source: "a", target: "a", type: "blocks" }]),
		);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.cycles).toEqual([["DATA-1", "DATA-1"]]);
		expect(result).not.toHaveProperty("totalDays");
	});

	test("`relates` edges carry no ordering and must not constrain", () => {
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 3)],
				[{ source: "a", target: "b", type: "relates" }],
			),
		);
		expect(result.connectedLeaves).toBe(0);
		expect(result.chain).toEqual([]);
	});

	test("an empty chain carries NO totalDays for `jq .totalDays` to read as 0", () => {
		// The cycle refusal was shaped so a script cannot read a fabricated floor off
		// it. The empty-chain success shape is the same escape one discriminator over:
		// the human formatter and the atlas gauge both special-cased it, and `--json`
		// did not — so a board with no dependency structure reported a floor of 0.
		const result = computed(graph([story("a", "P-1", 2), story("b", "P-2", 3)], []));
		expect(result.chain).toEqual([]);
		expect(result).not.toHaveProperty("totalDays");
	});

	test("epics are containers: their children carry the duration, not them", () => {
		const epic: AtlasNode = {
			...story("e", "P-0", 999),
			kind: "epic",
			children: [story("a", "P-1", 2), story("b", "P-2", 3)],
		} as AtlasNode;
		const result = computed(graph([epic], [{ source: "a", target: "b", type: "blocks" }]));
		// 5, not 1004 — counting the epic would double-count its own children.
		expect(result.totalDays).toBe(5);
		expect(result.consideredLeaves).toBe(2);
	});

	test("a leaf reached only by EXPANDING an epic endpoint is in the no-estimate set", () => {
		// The set drives the atlas filter the floor's tooltip names, and until now
		// every test of it used a direct story->story edge. An edge written against
		// the EPIC is expanded to its leaves, so a story can become connected — and
		// so become one of the stories making the total a lower bound — without ever
		// appearing as a literal edge endpoint. That is precisely the case where the
		// tooltip and the filter drifted apart before.
		const epic: AtlasNode = {
			...story("e", "P-0", null),
			kind: "epic",
			children: [story("child", "P-2", null), story("child2", "P-3", 1)],
		} as AtlasNode;
		const result = computed(
			graph([story("a", "P-1", 2), epic], [{ source: "a", target: "e", type: "blocks" }]),
		);
		// Two leaves under the epic, so one edge really became two.
		expect(result.expandedEdges).toBe(1);
		expect(result.isLowerBound).toBe(true);
		// The EPIC itself is not work and must not appear; its leaf must.
		expect(result.unestimatedIdentifiers).toEqual(["P-2"]);
		expect(result.unestimatedUnidentified).toBe(0);
	});

	test("an unestimated story with NO identifier is counted but reported unfindable", () => {
		// Unlinked markdown stories have no `PROJECT-N`, so the identifier-keyed
		// filter cannot select them. They still make the floor a lower bound, so
		// dropping them from the count would understate it — and leaving the gap
		// unreported makes the filter look broken instead of the story unlinked.
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", null, null)],
				[{ source: "a", target: "b", type: "blocks" }],
			),
		);
		expect(result.isLowerBound).toBe(true);
		expect(result.unestimated).toBe(1);
		expect(result.unestimatedIdentifiers).toEqual([]);
		expect(result.unestimatedUnidentified).toBe(1);
	});

	test("OFF-CHAIN unestimated work still makes the total a lower bound", () => {
		// Review P0.1, with its trigger. a(2)->b(3) wins at 5; a(2)->c(null) loses
		// ONLY BECAUSE the unknown was treated as 0. If c is really 10 days the
		// floor is 12, so reporting a confident 5 is the null-ban in its worst
		// form: absence coerced to zero, then the coerced comparison used to decide
		// the absence did not matter.
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 3), story("c", "P-3", null)],
				[
					{ source: "a", target: "b", type: "blocks" },
					{ source: "a", target: "c", type: "blocks" },
				],
			),
		);
		expect(result.chain.map((n) => n.identifier)).toEqual(["P-1", "P-2"]);
		expect(result.totalDays).toBe(5);
		// P-3 is NOT on the chain, and is exactly why 5 cannot be trusted.
		expect(result.unestimated).toBe(1);
		expect(result.isLowerBound).toBe(true);
	});

	test("the lever is the MEASURED drop in the floor, capped by the next path", () => {
		// Review P0.2 trigger A. a->b->d = 13 (critical), a->c = 11 (near-critical).
		// Finishing b(10) leaves 11, so it saves 2 — not its own 10 days.
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 10), story("d", "P-4", 1), story("c", "P-3", 9)],
				[
					{ source: "a", target: "b", type: "blocks" },
					{ source: "b", target: "d", type: "blocks" },
					{ source: "a", target: "c", type: "blocks" },
				],
			),
		);
		expect(result.totalDays).toBe(13);
		expect(result.biggestLever?.daysSaved).toBe(2);
	});

	test("the lever picks the item that actually saves most, not the biggest", () => {
		// Review P0.2 trigger B. a->b(10)->c = 14, a->d(9)->c = 13.
		// Finishing b saves 1; finishing a or c saves 2. The largest item on the
		// chain is the WORST choice, which is what the old implementation named.
		const result = computed(
			graph(
				[story("a", "P-1", 2), story("b", "P-2", 10), story("c", "P-3", 2), story("d", "P-4", 9)],
				[
					{ source: "a", target: "b", type: "blocks" },
					{ source: "b", target: "c", type: "blocks" },
					{ source: "a", target: "d", type: "blocks" },
					{ source: "d", target: "c", type: "blocks" },
				],
			),
		);
		expect(result.totalDays).toBe(14);
		expect(result.biggestLever?.daysSaved).toBe(2);
		expect(result.biggestLever?.identifier).not.toBe("P-2");
	});

	test("a blocks edge touching an EPIC is expanded, not dropped", () => {
		// Review P1.5. "This spike blocks the epic" is a thing people write, and
		// discarding the edge removes a real constraint — the floor comes out short.
		const epic: AtlasNode = {
			...story("e", "P-E", null),
			kind: "epic",
			children: [story("b", "P-2", 3), story("c", "P-3", 4)],
		} as AtlasNode;
		const result = computed(
			graph([story("a", "P-1", 5), epic], [{ source: "a", target: "e", type: "blocks" }]),
		);
		// a(5) must finish before either leaf starts: 5 + 4 = 9.
		expect(result.totalDays).toBe(9);
		expect(result.expandedEdges).toBe(1);
	});

	test("an epic blocking its own descendant does not invent sibling constraints", () => {
		const target = story("m2", "P-2", 3);
		const epic: AtlasNode = {
			...story("e", "P-E", null),
			kind: "epic",
			children: [story("m1", "P-1", 2), target, story("m3", "P-3", 4)],
		} as AtlasNode;
		const result = computed(
			graph([epic], [{ source: epic.id, target: target.id, type: "blocks" }]),
		);

		// E -> P-2 does not declare P-1 -> P-2 or P-3 -> P-2.
		expect(result.connectedLeaves).toBe(0);
		expect(result.expandedEdges).toBe(0);
		expect(result.chain).toEqual([]);
	});

	test("a self-referential children structure is refused by node name", () => {
		const epic = { ...story("e", "P-1", null), kind: "epic" as const };
		epic.children = [epic];

		expect(() => computeCriticalPath(graph([epic], []))).toThrow(/P-1/);
	});

	test("an unconnected board yields an empty result, distinguishable from a cycle", () => {
		const result = computed(graph([story("a", "P-1", 2)], []));
		expect(result.chain).toEqual([]);
		expect(result.cycles).toEqual([]);
		expect(result.consideredLeaves).toBe(1);
	});
});
