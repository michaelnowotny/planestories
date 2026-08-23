import { describe, expect, test } from "bun:test";
import { type AtlasGraph, type AtlasNode, buildAtlasFromBoard } from "../../../src/atlas/model.ts";
import { ConfigError } from "../../../src/errors.ts";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { groupQueryItems, queryStories, renderCountText } from "../../../src/sync/query.ts";
import { rollupEpic } from "../../../src/sync/rollup.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

function node(overrides: Partial<AtlasNode> & Pick<AtlasNode, "id" | "title">): AtlasNode {
	const { id, title, ...rest } = overrides;
	return {
		id,
		kind: "story",
		title,
		identifier: null,
		url: null,
		status: "Backlog",
		statusGroup: "backlog",
		labels: [],
		assignee: null,
		effortDays: 1,
		priority: null,
		createdAt: null,
		updatedAt: null,
		criteria: [],
		quality: { ok: true, flags: [] },
		children: [],
		...rest,
	};
}

function fixtureGraph(): AtlasGraph {
	const subEpic = node({
		id: "sub",
		kind: "epic",
		title: "Nested epic",
		identifier: "DATA-2",
		quality: null,
		children: [
			node({
				id: "c",
				title: "Completed UI story",
				identifier: "DATA-5",
				status: "Done",
				statusGroup: "completed",
				labels: ["UI"],
				assignee: "alice@example.test",
			}),
			node({
				id: "d",
				title: "Cancelled story",
				identifier: "DATA-6",
				status: "Cancelled",
				statusGroup: "cancelled",
				effortDays: null,
			}),
		],
	});
	const rootEpic = node({
		id: "root",
		kind: "epic",
		title: "Root epic",
		identifier: "DATA-1",
		quality: null,
		children: [
			node({
				id: "a",
				title: "Flagged blocked story",
				identifier: "DATA-3",
				labels: ["Backend"],
				assignee: "alice@example.test",
				effortDays: null,
				quality: { ok: false, flags: ["thin description"] },
			}),
			node({
				id: "b",
				title: "Active blocker",
				identifier: "DATA-4",
				status: "In Progress",
				statusGroup: "started",
				labels: ["Backend"],
				assignee: "bob@example.test",
				effortDays: 2,
			}),
			subEpic,
		],
	});
	const standalone = node({
		id: "e",
		title: "Standalone unestimated story",
		identifier: "DATA-7",
		labels: ["Operations"],
		effortDays: null,
	});

	return {
		project: "Data Platform",
		source: "board",
		nodes: [rootEpic, standalone],
		edges: [{ source: "b", target: "a", type: "blocks" }],
		labels: ["Backend", "Operations", "UI"],
		assignees: ["alice@example.test", "bob@example.test"],
		statuses: ["Backlog", "In Progress", "Done", "Cancelled"],
		counts: { epics: 2, stories: 5, criteria: 0, flagged: 1, edges: 1 },
	};
}

function ids(graph: AtlasGraph, predicates: Parameters<typeof queryStories>[1]): string[] {
	return queryStories(graph, predicates).items.map((item) => item.identifier ?? "(unlinked)");
}

describe("queryStories predicates", () => {
	test("each fixed predicate has one exact, case-insensitive meaning", () => {
		const graph = fixtureGraph();

		expect(ids(graph, { open: true })).toEqual(["DATA-3", "DATA-4", "DATA-7"]);
		expect(ids(graph, { status: "in progress" })).toEqual(["DATA-4"]);
		expect(ids(graph, { label: "backend" })).toEqual(["DATA-3", "DATA-4"]);
		expect(ids(graph, { assignee: "ALICE@EXAMPLE.TEST" })).toEqual(["DATA-3", "DATA-5"]);
		expect(ids(graph, { epic: "data-1" })).toEqual(["DATA-3", "DATA-4", "DATA-5", "DATA-6"]);
		expect(ids(graph, { flagged: true })).toEqual(["DATA-3"]);
		expect(ids(graph, { noEstimate: true })).toEqual(["DATA-3", "DATA-6", "DATA-7"]);
		expect(ids(graph, { blocked: true })).toEqual(["DATA-3"]);
	});

	test("predicates compose with AND, without a query-language precedence layer", () => {
		const result = queryStories(fixtureGraph(), {
			open: true,
			status: "Backlog",
			label: "Backend",
			assignee: "alice@example.test",
			epic: "DATA-1",
			flagged: true,
			noEstimate: true,
			blocked: true,
		});

		expect(result.items.map((item) => item.identifier)).toEqual(["DATA-3"]);
		expect(result.count).toBe(1);
		// The epic is the scope/denominator; all other predicates narrow the numerator.
		expect(result.denominator).toBe(4);
	});

	test("a blocked story needs an unfinished blocker and must itself still be open", () => {
		const graph = fixtureGraph();
		const blocker = graph.nodes[0]?.children.find((child) => child.id === "b");
		expect(blocker).toBeDefined();
		if (!blocker) return;
		blocker.status = "Done";
		blocker.statusGroup = "completed";

		expect(ids(graph, { blocked: true })).toEqual([]);
	});

	test("an epic endpoint is expanded through the critical-path leaf projection", () => {
		const graph = fixtureGraph();
		graph.edges = [{ source: "e", target: "root", type: "blocks" }];

		expect(ids(graph, { epic: "DATA-1", blocked: true })).toEqual(["DATA-3", "DATA-4"]);
	});

	test("a missing or non-epic identifier refuses and names an answering route", () => {
		expect(() => queryStories(fixtureGraph(), { epic: "DATA-404" })).toThrow(ConfigError);
		expect(() => queryStories(fixtureGraph(), { epic: "DATA-404" })).toThrow(
			/planestories ls --json/,
		);
		expect(() => queryStories(fixtureGraph(), { epic: "DATA-3" })).toThrow(
			/planestories show 'DATA-3'/,
		);
	});

	test("an explicitly present blank predicate fails instead of becoming no filter", () => {
		for (const predicates of [{ status: "" }, { label: " " }, { assignee: "\t" }, { epic: "" }]) {
			expect(() => queryStories(fixtureGraph(), predicates)).toThrow(/must not be blank/);
		}
	});
});

describe("count denominator and grouping", () => {
	test("the epic scope is the denominator, never a bare numerator", () => {
		const result = queryStories(fixtureGraph(), { epic: "DATA-1", open: true });

		expect(result.count).toBe(2);
		expect(result.denominator).toBe(4);
		expect(result.availableEpics).toEqual([
			{ identifier: "DATA-1", title: "Root epic" },
			{ identifier: "DATA-2", title: "Nested epic" },
		]);
		expect(renderCountText(result, [])).toContain("2 open of 4");
	});

	test("every group carries the selected-set denominator", () => {
		const result = queryStories(fixtureGraph(), { open: true });

		expect(groupQueryItems(result.items, "status")).toEqual([
			{ value: "Backlog", count: 2, denominator: 3 },
			{ value: "In Progress", count: 1, denominator: 3 },
		]);
		expect(groupQueryItems(result.items, "assignee")).toEqual([
			{ value: "alice@example.test", count: 1, denominator: 3 },
			{ value: "bob@example.test", count: 1, denominator: 3 },
			{ value: null, count: 1, denominator: 3 },
		]);
		expect(groupQueryItems(result.items, "label")).toEqual([
			{ value: "Backend", count: 2, denominator: 3 },
			{ value: "Operations", count: 1, denominator: 3 },
		]);
		expect(groupQueryItems(result.items, "epic")).toEqual([
			{ value: "DATA-1", count: 2, denominator: 3 },
			{ value: null, count: 1, denominator: 3 },
		]);
	});
});

test("count --epic X --open agrees with the existing epic rollup", async () => {
	const projectId = "aaaaaaaa-2222-3333-4444-555555555555";
	const config: ResolvedConfig = {
		apiKey: "k",
		workspaceSlug: "ws",
		baseUrl: "https://api.plane.so",
		defaultProject: "Data Platform",
		defaultLabels: [],
		sourceLabel: null,
		maxRetries: 5,
	};
	const { client } = makeFakeClient({
		projects: [{ id: projectId, name: "Data Platform", identifier: "DATA" }],
		workItems: {
			[projectId]: [
				{
					id: "root",
					sequence_id: 1,
					name: "Root epic",
					state: { name: "In Progress", group: "started" },
				},
				{
					id: "open",
					sequence_id: 2,
					name: "Open leaf",
					parent: "root",
					state: { name: "Backlog", group: "backlog" },
				},
				{
					id: "sub",
					sequence_id: 3,
					name: "Nested epic",
					parent: "root",
					state: { name: "In Progress", group: "started" },
				},
				{
					id: "done",
					sequence_id: 4,
					name: "Done leaf",
					parent: "sub",
					state: { name: "Done", group: "completed" },
				},
				{
					id: "cancelled",
					sequence_id: 5,
					name: "Cancelled leaf",
					parent: "sub",
					state: { name: "Cancelled", group: "cancelled" },
				},
			],
		},
	});
	const index = await fetchProjectIndex(client, projectId, "DATA");
	const graph = buildAtlasFromBoard(client, projectId, "DATA", "Data Platform", index);
	const query = queryStories(graph, { epic: "DATA-1", open: true });
	const { rollup } = await rollupEpic(client, { config, identifier: "DATA-1" });

	expect(query.denominator).toBe(rollup.leafTotal);
	expect(query.count).toBe(rollup.leafTotal - rollup.completed - rollup.cancelled);
});
