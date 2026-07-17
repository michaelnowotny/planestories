import { describe, expect, test } from "bun:test";
import { groom } from "../../src/sync/groomer.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT = "proj-1";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Proj",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function boardData(extra?: Partial<FakeData>): FakeData {
	return {
		projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
		states: {
			[PROJECT]: [
				{ id: "done", name: "Done", group: "completed" },
				{ id: "backlog", name: "Backlog", group: "backlog" },
			],
		},
		workItems: {
			[PROJECT]: [
				// Orphaned criterion: parent done, child still open -> should close.
				{
					id: "parent",
					sequence_id: 1,
					name: "Parent story",
					state: { name: "Done", group: "completed" },
				},
				{
					id: "crit",
					sequence_id: 2,
					name: "a criterion",
					parent: "parent",
					external_id: "parent-story::ac0",
					external_source: "planestories",
					state: { name: "Backlog", group: "backlog" },
				},
				// Done EPIC with an open child STORY (no ::acN) -> must NEVER be closed.
				{ id: "epic", sequence_id: 3, name: "Epic", state: { name: "Done", group: "completed" } },
				{
					id: "childstory",
					sequence_id: 4,
					name: "Child story",
					parent: "epic",
					state: { name: "Backlog", group: "backlog" },
				},
				// Duplicate-title stories (normalized) -> report only.
				{ id: "dupA", sequence_id: 5, name: "Same title", state: { name: "Backlog" } },
				{ id: "dupB", sequence_id: 6, name: "same title", state: { name: "Backlog" } },
				// Parentless criterion sub-item -> report only.
				{
					id: "orphan",
					sequence_id: 7,
					name: "orphan crit",
					parent: "ghost",
					external_id: "ghost::ac0",
					external_source: "planestories",
					state: { name: "Backlog", group: "backlog" },
				},
			],
		},
		...extra,
	};
}

describe("groom", () => {
	test("dry-run reports orphaned/duplicate/parentless and makes NO writes", async () => {
		const { client, updatedItems, createdComments } = makeFakeClient(boardData());
		const report = await groom(client, { config });

		expect(report.orphanedCriteria.map((c) => c.identifier)).toEqual(["ENG-2"]);
		expect(report.orphanedCriteria[0]?.parentIdentifier).toBe("ENG-1");
		expect(report.duplicateTitles).toHaveLength(1);
		expect(report.duplicateTitles[0]?.identifiers.sort()).toEqual(["ENG-5", "ENG-6"]);
		expect(report.parentlessCriteria.map((c) => c.identifier)).toEqual(["ENG-7"]);
		// Dry run: nothing applied.
		expect(report.closed).toBe(0);
		expect(updatedItems).toHaveLength(0);
		expect(createdComments).toHaveLength(0);
	});

	test("--yes closes ONLY the orphaned criterion, never the epic's child story", async () => {
		const { client, updatedItems, createdComments } = makeFakeClient(boardData());
		const report = await groom(client, { config, apply: true });

		expect(report.closed).toBe(1);
		expect(report.commentsPosted).toBe(1);
		// Exactly one item updated — the criterion sub-item, closed into a completed state.
		expect(updatedItems).toHaveLength(1);
		expect(updatedItems[0]?.workItemId).toBe("crit");
		expect(updatedItems[0]?.body).toEqual({ state: "done" });
		// The child STORY of the done epic was NOT touched.
		expect(updatedItems.some((u) => u.workItemId === "childstory")).toBe(false);
		// A marker comment was posted on the criterion.
		expect(createdComments).toHaveLength(1);
		expect(createdComments[0]?.workItemId).toBe("crit");
	});

	test("idempotent: an existing marker comment isn't re-posted (still closes)", async () => {
		const { client, updatedItems, createdComments } = makeFakeClient(
			boardData({
				comments: {
					crit: [{ comment_html: "<p>earlier [planestories:auto-closed-with-parent]</p>" }],
				},
			}),
		);
		const report = await groom(client, { config, apply: true });

		expect(report.closed).toBe(1);
		expect(report.commentsPosted).toBe(0); // marker already present
		expect(updatedItems.map((u) => u.workItemId)).toEqual(["crit"]);
		expect(createdComments).toHaveLength(0);
	});

	test("an already-closed criterion is left alone", async () => {
		const { client, updatedItems } = makeFakeClient(
			boardData({
				workItems: {
					[PROJECT]: [
						{
							id: "parent",
							sequence_id: 1,
							name: "P",
							state: { name: "Done", group: "completed" },
						},
						{
							id: "crit",
							sequence_id: 2,
							name: "a criterion",
							parent: "parent",
							external_id: "p::ac0",
							external_source: "planestories",
							state: { name: "Done", group: "completed" }, // already done
						},
					],
				},
			}),
		);
		const report = await groom(client, { config, apply: true });

		expect(report.orphanedCriteria).toHaveLength(0);
		expect(report.closed).toBe(0);
		expect(updatedItems).toHaveLength(0);
	});
});
