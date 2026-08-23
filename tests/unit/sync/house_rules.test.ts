import { describe, expect, test } from "bun:test";
import type { PlaneIssueRelations } from "../../../src/plane/client.ts";
import type { FetchedWorkItem, ProjectIndex } from "../../../src/plane/issues.ts";
import { checkHouseRules } from "../../../src/sync/house_rules.ts";

const item = (
	id: string,
	sequenceId: number,
	description = "",
	extra: Partial<FetchedWorkItem> = {},
): FetchedWorkItem => ({
	id,
	sequenceId,
	name: `Item ${sequenceId}`,
	createdAt: null,
	updatedAt: null,
	description,
	priority: undefined,
	estimate: undefined,
	stateName: "Backlog",
	assigneeEmail: undefined,
	assigneeDisplayName: undefined,
	labels: [],
	externalSource: undefined,
	externalId: undefined,
	parent: undefined,
	stateGroup: "backlog",
	...extra,
});
const indexOf = (items: FetchedWorkItem[]): ProjectIndex => {
	const byId = new Map(items.map((value) => [value.id, value]));
	const byIdentifier = new Map(items.map((value) => [`DATA-${value.sequenceId}`, value]));
	const childrenByParent = new Map<string, FetchedWorkItem[]>();
	for (const value of items)
		if (value.parent)
			childrenByParent.set(value.parent, [...(childrenByParent.get(value.parent) ?? []), value]);
	return { items, byId, byIdentifier, byNormalizedTitle: new Map(), childrenByParent };
};
const relation = (extra: Partial<PlaneIssueRelations> = {}): PlaneIssueRelations => ({
	blocking: [],
	blocked_by: [],
	relates_to: [],
	duplicate: [],
	start_before: [],
	start_after: [],
	finish_before: [],
	finish_after: [],
	...extra,
});

describe("checkHouseRules", () => {
	test("checks effort only for open non-epic stories", () => {
		const story = item("story", 1, "No effort");
		const closed = item("closed", 2, "No effort", { stateGroup: "completed" });
		const epic = item("epic", 3, "No effort");
		const child = item("child", 4, "No effort", { parent: "epic" });
		const criterion = item("criterion", 5, "No effort", {
			parent: "story",
			externalId: "story::ac0",
		});
		const report = checkHouseRules(
			indexOf([story, closed, epic, child, criterion]),
			new Map(),
			"DATA",
		);
		expect(report.missingEffort.map((x) => x.identifier)).toEqual(["DATA-1", "DATA-4"]);
	});

	test("splits satisfied, missing, and unknown dependency targets", () => {
		const source = item("source", 1, "**Effort:** 1 dev-day\nDepends on: DATA-2, DATA-3, NOPE-9");
		const target2 = item("two", 2, "**Effort:** 1 dev-day");
		const target3 = item("three", 3, "**Effort:** 1 dev-day");
		const report = checkHouseRules(
			indexOf([source, target2, target3]),
			new Map([["source", relation({ blocked_by: ["two"] })]]),
			"DATA",
		);
		expect(report.proseDepsWithoutRelation).toEqual([
			{
				identifier: "DATA-1",
				title: "Item 1",
				directive: "depends on",
				missing: ["DATA-3"],
				unknownTargets: ["NOPE-9"],
			},
		]);
	});

	test("ignores code fences and prose without identifiers", () => {
		const source = item(
			"source",
			1,
			"**Effort:** 1 dev-day\n```\n**Blocks:** DATA-2\n```\nThis depends on the governor",
		);
		const report = checkHouseRules(indexOf([source, item("two", 2)]), new Map(), "DATA");
		expect(report.proseDepsWithoutRelation).toEqual([]);
	});

	test("accepts a dependency colon inside or outside bold markers", () => {
		const inside = item("inside", 1, "**Effort:** 1 dev-day\n**Depends on:** DATA-3");
		const outside = item("outside", 2, "**Effort:** 1 dev-day\n**Depends on**: DATA-3");
		const target = item("target", 3, "**Effort:** 1 dev-day");
		const report = checkHouseRules(indexOf([inside, outside, target]), new Map(), "DATA");
		expect(report.proseDepsWithoutRelation.map((finding) => finding.identifier)).toEqual([
			"DATA-1",
			"DATA-2",
		]);
	});
});
