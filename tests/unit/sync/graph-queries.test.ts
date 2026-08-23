import { describe, expect, test } from "bun:test";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import {
	queryAbandoned,
	queryBlocked,
	queryInconsistent,
	queryOrphans,
	queryReady,
} from "../../../src/sync/graph_queries.ts";

function story(id: string, statusGroup: AtlasNode["statusGroup"] = "unstarted"): AtlasNode {
	return {
		id,
		kind: "story",
		title: `Title ${id}`,
		identifier: `P-${id.slice(1)}`,
		url: null,
		status:
			statusGroup === "completed"
				? "Done"
				: statusGroup === "cancelled"
					? "Cancelled"
					: statusGroup === "started"
						? "In Progress"
						: statusGroup === "unknown"
							? null
							: "Todo",
		statusGroup,
		labels: [],
		assignee: null,
		effortDays: 1,
		priority: null,
		createdAt: null,
		updatedAt: null,
		criteria: [],
		quality: null,
		children: [],
	};
}

function epic(id: string, children: AtlasNode[], statusGroup: AtlasNode["statusGroup"]): AtlasNode {
	return { ...story(id, statusGroup), kind: "epic", children };
}

function graph(nodes: AtlasNode[], edges: AtlasEdge[] = []): AtlasGraph {
	const flat = (items: AtlasNode[]): AtlasNode[] =>
		items.flatMap((node) => [node, ...flat(node.children)]);
	const all = flat(nodes);
	return {
		project: "Query Board",
		source: "board",
		nodes,
		edges,
		labels: [],
		assignees: [],
		statuses: [],
		counts: {
			epics: all.filter((node) => node.kind === "epic").length,
			stories: all.filter((node) => node.kind === "story").length,
			criteria: 0,
			flagged: 0,
			edges: edges.length,
		},
	};
}

function identifiers(items: Array<{ item: { identifier: string | null } }>): Array<string | null> {
	return items.map(({ item }) => item.identifier);
}

describe("ready", () => {
	test("excludes a blocked item, then includes it after its blocker completes", () => {
		const blocker = story("n1", "started");
		blocker.title = "Finish the prerequisite";
		const target = story("n2", "unstarted");
		target.title = "Visible downstream title";
		const unrelated = story("n3", "backlog");
		const edge: AtlasEdge = { source: blocker.id, target: target.id, type: "blocks" };

		const before = queryReady(graph([blocker, target, unrelated], [edge]));
		expect(identifiers(before.items)).not.toContain("P-2");
		expect(identifiers(before.items)[0]).toBe("P-1");
		expect(before.items[0]?.unblocks).toMatchObject([
			{ identifier: "P-2", title: "Visible downstream title" },
		]);

		const completedBlocker = {
			...blocker,
			status: "Done",
			statusGroup: "completed" as const,
		};
		const after = queryReady(graph([completedBlocker, target, unrelated], [edge]));
		expect(identifiers(after.items)).toContain("P-2");
	});

	test("ranks by distinct work immediately released and preserves the pre-limit match count", () => {
		const first = story("n1");
		const second = story("n2");
		const targetA = story("n3");
		const targetB = story("n4");
		const targetC = story("n5");
		const value = graph(
			[first, second, targetA, targetB, targetC],
			[
				{ source: first.id, target: targetA.id, type: "blocks" },
				{ source: first.id, target: targetB.id, type: "blocks" },
				{ source: second.id, target: targetC.id, type: "blocks" },
			],
		);

		const report = queryReady(value, { limit: 1 });
		expect(identifiers(report.items)).toEqual(["P-1"]);
		expect(report.items[0]?.unblocks).toHaveLength(2);
		expect(report.matched).toBe(2);
	});

	test("uses the shared leaf projection when a dependency edge targets an epic", () => {
		const blocker = story("n1");
		const childA = story("n3");
		childA.title = "First projected child";
		const childB = story("n4");
		childB.title = "Second projected child";
		const container = epic("n2", [childA, childB], "started");
		const report = queryReady(
			graph([blocker, container], [{ source: blocker.id, target: container.id, type: "blocks" }]),
		);

		expect(identifiers(report.items)).toEqual(["P-1"]);
		expect(report.items[0]?.unblocks.map((item) => item.title)).toEqual([
			"First projected child",
			"Second projected child",
		]);
	});

	test("a cancelled blocker is resolved, while an unknown blocker is unfinished", () => {
		const cancelled = story("n1", "cancelled");
		const unknown = story("n2", "unknown");
		const released = story("n3", "unstarted");
		const uncertain = story("n4", "unstarted");
		const value = graph(
			[cancelled, unknown, released, uncertain],
			[
				{ source: cancelled.id, target: released.id, type: "blocks" },
				{ source: unknown.id, target: uncertain.id, type: "blocks" },
			],
		);

		expect(identifiers(queryReady(value).items)).toContain("P-3");
		expect(identifiers(queryReady(value).items)).not.toContain("P-4");
		expect(identifiers(queryBlocked(value).items)).toContain("P-4");
	});
});

describe("inconsistent and blocked", () => {
	test("reports both inconsistency directions with titled blockers", () => {
		const openBlocker = story("n1", "started");
		openBlocker.title = "Open evidence bucket";
		const prematureDone = story("n2", "completed");
		prematureDone.title = "Prematurely closed result";
		const doneBlocker = story("n3", "completed");
		doneBlocker.title = "Completed prerequisite";
		const untouched = story("n4", "unstarted");
		const report = queryInconsistent(
			graph(
				[openBlocker, prematureDone, doneBlocker, untouched],
				[
					{ source: openBlocker.id, target: prematureDone.id, type: "blocks" },
					{ source: doneBlocker.id, target: untouched.id, type: "blocks" },
				],
			),
		);

		expect(identifiers(report.doneWithUnfinishedBlockers)).toEqual(["P-2"]);
		expect(report.doneWithUnfinishedBlockers[0]?.blockers[0]?.title).toBe("Open evidence bucket");
		expect(identifiers(report.notStartedWithDoneBlockers)).toEqual(["P-4"]);
		expect(report.notStartedWithDoneBlockers[0]?.blockers[0]?.title).toBe("Completed prerequisite");
	});

	test("blocked lists only open leaves with an unfinished blocker", () => {
		const openBlocker = story("n1", "started");
		openBlocker.title = "Still-open blocker";
		const doneBlocker = story("n2", "completed");
		const blockedTarget = story("n3", "backlog");
		const readyTarget = story("n4", "backlog");
		const report = queryBlocked(
			graph(
				[openBlocker, doneBlocker, blockedTarget, readyTarget],
				[
					{ source: openBlocker.id, target: blockedTarget.id, type: "blocks" },
					{ source: doneBlocker.id, target: readyTarget.id, type: "blocks" },
				],
			),
		);

		expect(identifiers(report.items)).toEqual(["P-3"]);
		expect(report.items[0]?.blockers[0]?.title).toBe("Still-open blocker");
	});
});

describe("orphans and abandoned", () => {
	test("orphans is a leaf blocks-graph property and never ranks by age", () => {
		const connectedA = story("n1");
		const connectedB = story("n2");
		const recent = story("n3");
		recent.createdAt = "2026-08-22T00:00:00Z";
		const old = story("n4");
		old.createdAt = "2020-01-01T00:00:00Z";
		const container = epic("n5", [recent, old], "started");
		const report = queryOrphans(
			graph(
				[connectedA, connectedB, container],
				[
					{ source: connectedA.id, target: connectedB.id, type: "blocks" },
					{ source: recent.id, target: old.id, type: "relates" },
				],
			),
		);

		expect(identifiers(report.items)).toEqual(["P-3", "P-4"]);
		expect(identifiers(report.items)).not.toContain("P-5");
	});

	test("abandoned reports open leaves under the nearest cancelled epic ancestor", () => {
		const leaf = story("n3", "backlog");
		const doneLeaf = story("n4", "completed");
		const nested = epic("n2", [leaf, doneLeaf], "started");
		const abandonedRoot = epic("n1", [nested], "cancelled");
		abandonedRoot.title = "Cancelled programme";
		const report = queryAbandoned(graph([abandonedRoot]));

		expect(identifiers(report.items)).toEqual(["P-3"]);
		expect(report.items[0]?.parent).toMatchObject({
			identifier: "P-1",
			title: "Cancelled programme",
		});
	});
});

test("epic scoping uses descendant leaves but keeps external blockers visible", () => {
	const target = story("n2", "backlog");
	const root = epic("n1", [target], "started");
	const externalBlocker = story("n3", "started");
	externalBlocker.title = "External prerequisite";
	const value = graph(
		[root, externalBlocker],
		[{ source: externalBlocker.id, target: target.id, type: "blocks" }],
	);

	const report = queryBlocked(value, { epic: "p-1" });
	expect(identifiers(report.items)).toEqual(["P-2"]);
	expect(report.items[0]?.blockers[0]).toMatchObject({
		identifier: "P-3",
		title: "External prerequisite",
		statusGroup: "started",
	});
});

test("bad epic scopes and limits refuse with an answering route before returning a result", () => {
	const value = graph([epic("n1", [story("n2")], "started")]);
	const routes = {
		listEpicIdentifiers: "planestories ls --json --from-snapshot board.json",
		showItem: (identifier: string) => `planestories show ${identifier}`,
	};

	expect(() => queryReady(value, { epic: "P-404" }, routes)).toThrow(
		/planestories ls --json --from-snapshot board\.json/,
	);
	expect(() => queryReady(value, { epic: "P-2" }, routes)).toThrow(/planestories show P-2/);
	for (const limit of [0, -1, 1.5, Number.NaN]) {
		expect(() => queryReady(value, { limit })).toThrow(/positive integer/);
	}
});
