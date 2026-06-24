import { describe, expect, test } from "bun:test";
import { filterWorkItems } from "../../../src/plane/filters.ts";
import type { FetchedWorkItem } from "../../../src/plane/issues.ts";

function item(overrides: Partial<FetchedWorkItem>): FetchedWorkItem {
	return {
		id: "wi-1",
		sequenceId: 1,
		name: "Item",
		description: undefined,
		priority: undefined,
		estimate: undefined,
		stateName: undefined,
		assigneeEmail: undefined,
		assigneeDisplayName: undefined,
		labels: [],
		externalSource: undefined,
		externalId: undefined,
		parent: undefined,
		stateGroup: undefined,
		...overrides,
	};
}

const IDENT = "BLOOM";

describe("filterWorkItems", () => {
	const items = [
		item({ id: "a", sequenceId: 8, stateName: "Backlog", assigneeEmail: "jane@co.com" }),
		item({ id: "b", sequenceId: 12, stateName: "Done", assigneeEmail: "bob@co.com" }),
	];

	test("returns all items when no filters given", () => {
		expect(filterWorkItems(items, {}, IDENT)).toHaveLength(2);
	});

	test("filters by identifier", () => {
		const result = filterWorkItems(items, { identifiers: ["BLOOM-8"] }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});

	test("identifier match is case-insensitive", () => {
		const result = filterWorkItems(items, { identifiers: ["bloom-12"] }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["b"]);
	});

	test("filters by status name (case-insensitive)", () => {
		const result = filterWorkItems(items, { statusName: "done" }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["b"]);
	});

	test("filters by assignee email", () => {
		const result = filterWorkItems(items, { assigneeEmail: "jane@co.com" }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});

	test("combines filters (AND)", () => {
		const result = filterWorkItems(
			items,
			{ statusName: "Backlog", assigneeEmail: "jane@co.com" },
			IDENT,
		);
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});

	test("filters by external_source", () => {
		const tagged = [
			item({ id: "a", externalSource: "planestories" }),
			item({ id: "b", externalSource: undefined }),
		];
		const result = filterWorkItems(tagged, { externalSource: "planestories" }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});

	test("filters by label (case-insensitive)", () => {
		const labeled = [item({ id: "a", labels: ["Bug", "UI"] }), item({ id: "b", labels: ["Docs"] })];
		const result = filterWorkItems(labeled, { label: "bug" }, IDENT);
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});
});
