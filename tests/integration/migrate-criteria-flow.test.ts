import { describe, expect, test } from "bun:test";
import { fetchProjectIndex } from "../../src/plane/issues.ts";
import { checkCriteriaMigration, migrateCriteria } from "../../src/sync/migrate.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

// A migrated description: the writer always emits the `### Acceptance Criteria`
// heading before the task-list, so the AC-section-scoped fence recognizes it.
const TASKLIST_HTML =
	'<p>n</p><h3>Acceptance Criteria</h3><ul class="todo-list" data-type="taskList"><li data-type="taskItem" data-checked="false"><p>c</p></li></ul>';

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

/** A parent with a narrative-only description and two `::ac<n>` children. */
function boardData(overrides?: Partial<FakeData>): FakeData {
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
				{
					id: "parent",
					sequence_id: 1,
					name: "Parent story",
					description_html: "<p>Some narrative.</p>",
					state: { name: "Backlog", group: "backlog" },
				},
				{
					id: "c0",
					sequence_id: 2,
					name: "first criterion",
					parent: "parent",
					external_id: "parent-story::ac0",
					external_source: "planestories",
					state: { name: "Done", group: "completed" },
				},
				{
					id: "c1",
					sequence_id: 3,
					name: "second criterion",
					parent: "parent",
					external_id: "parent-story::ac1",
					external_source: "planestories",
					state: { name: "Backlog", group: "backlog" },
				},
			],
		},
		...overrides,
	};
}

describe("migrateCriteria", () => {
	test("dry-run reports the fold and writes nothing", async () => {
		const fake = makeFakeClient(boardData());
		const report = await migrateCriteria(fake.client, { config, project: "Proj" });

		expect(report.applied).toBe(false);
		expect(report.migrated).toHaveLength(1);
		expect(report.criteriaFolded).toBe(2);
		expect(report.migrated[0]?.identifier).toBe("ENG-1");
		expect(fake.updatedItems).toHaveLength(0);
		expect(fake.createdComments).toHaveLength(0);
	});

	test("apply folds children into the parent description as a task-list and closes open children", async () => {
		const fake = makeFakeClient(boardData());
		const report = await migrateCriteria(fake.client, { config, project: "Proj", apply: true });

		expect(report.criteriaFolded).toBe(2);
		// Only the OPEN child (c1) is closed; c0 was already completed.
		expect(report.childrenClosed).toBe(1);

		// Parent description updated to a TipTap task-list with the derived states.
		const parentUpdate = fake.updatedItems.find((u) => u.workItemId === "parent");
		expect(parentUpdate).toBeDefined();
		const html = parentUpdate?.body.description_html as string;
		expect(html).toContain('data-type="taskList"');
		expect(html).toContain('data-checked="true"'); // first criterion (completed child)
		expect(html).toContain('data-checked="false"'); // second criterion (open child)
		expect(html).toContain("Some narrative."); // prefix preserved

		// The open child was moved to the completed state + got the idempotent marker.
		const childClose = fake.updatedItems.find((u) => u.workItemId === "c1");
		expect(childClose?.body.state).toBe("done");
		expect(fake.createdComments.some((c) => c.workItemId === "c1")).toBe(true);
	});

	test("re-run is idempotent (already-migrated parent, no re-fold)", async () => {
		const fake = makeFakeClient(boardData());
		await migrateCriteria(fake.client, { config, project: "Proj", apply: true });
		const writesAfterFirst = fake.updatedItems.length;

		const second = await migrateCriteria(fake.client, { config, project: "Proj", apply: true });
		expect(second.migrated).toHaveLength(0);
		expect(second.criteriaFolded).toBe(0);
		// Fully migrated (checklist + all children closed) → excluded from the window
		// entirely, so it isn't even reported as alreadyMigrated (keeps --limit advancing).
		expect(second.alreadyMigrated).toHaveLength(0);
		expect(second.childrenClosed).toBe(0);
		// No parent re-write on the second run.
		expect(fake.updatedItems.length).toBe(writesAfterFirst);
	});

	test("uses the full child description when the name was truncated", async () => {
		const long = `${"x".repeat(300)} full text`;
		const fake = makeFakeClient(
			boardData({
				workItems: {
					[PROJECT]: [
						{
							id: "parent",
							sequence_id: 1,
							name: "Parent story",
							description_html: "<p>n</p>",
							state: { name: "Backlog", group: "backlog" },
						},
						{
							id: "c0",
							sequence_id: 2,
							name: "truncated name…",
							description_html: `<p>${long}</p>`,
							parent: "parent",
							external_id: "parent-story::ac0",
							external_source: "planestories",
							state: { name: "Backlog", group: "backlog" },
						},
					],
				},
			}),
		);
		const report = await migrateCriteria(fake.client, { config, project: "Proj", apply: true });
		expect(report.criteriaFolded).toBe(1);
		const html = fake.updatedItems.find((u) => u.workItemId === "parent")?.body
			.description_html as string;
		expect(html).toContain("full text");
		expect(html).not.toContain("truncated name");
	});

	test("skips a parent with a duplicate ::ac index (conflict, never guesses)", async () => {
		const fake = makeFakeClient(
			boardData({
				workItems: {
					[PROJECT]: [
						{
							id: "parent",
							sequence_id: 1,
							name: "Parent story",
							description_html: "<p>n</p>",
							state: { name: "Backlog", group: "backlog" },
						},
						{
							id: "c0",
							sequence_id: 2,
							name: "a",
							parent: "parent",
							external_id: "parent-story::ac0",
							external_source: "planestories",
							state: { name: "Backlog", group: "backlog" },
						},
						{
							id: "c0dup",
							sequence_id: 3,
							name: "b",
							parent: "parent",
							external_id: "renamed-story::ac0",
							external_source: "planestories",
							state: { name: "Backlog", group: "backlog" },
						},
					],
				},
			}),
		);
		const report = await migrateCriteria(fake.client, { config, project: "Proj", apply: true });
		expect(report.migrated).toHaveLength(0);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0]?.identifier).toBe("ENG-1");
		expect(fake.updatedItems).toHaveLength(0); // nothing touched
	});

	test("--limit defers parents past the cap", async () => {
		const fake = makeFakeClient(
			boardData({
				workItems: {
					[PROJECT]: [
						{
							id: "p1",
							sequence_id: 1,
							name: "P1",
							description_html: "<p>n</p>",
							state: { group: "backlog" },
						},
						{
							id: "p1c",
							sequence_id: 2,
							name: "c",
							parent: "p1",
							external_id: "p1::ac0",
							external_source: "planestories",
							state: { group: "backlog" },
						},
						{
							id: "p2",
							sequence_id: 3,
							name: "P2",
							description_html: "<p>n</p>",
							state: { group: "backlog" },
						},
						{
							id: "p2c",
							sequence_id: 4,
							name: "c",
							parent: "p2",
							external_id: "p2::ac0",
							external_source: "planestories",
							state: { group: "backlog" },
						},
					],
				},
			}),
		);
		const report = await migrateCriteria(fake.client, {
			config,
			project: "Proj",
			apply: true,
			limit: 1,
		});
		expect(report.migrated).toHaveLength(1);
		expect(report.deferred).toBe(1);
		expect(report.migrated[0]?.identifier).toBe("ENG-1"); // lowest sequence first
	});

	test("--limit ADVANCES across runs (fully-migrated parents leave the window)", async () => {
		const items: NonNullable<FakeData["workItems"]>[string] = [];
		for (let n = 1; n <= 3; n++) {
			items.push({
				id: `p${n}`,
				sequence_id: n * 2 - 1,
				name: `P${n}`,
				description_html: "<p>n</p>",
				state: { group: "backlog" },
			});
			items.push({
				id: `p${n}c`,
				sequence_id: n * 2,
				name: "c",
				parent: `p${n}`,
				external_id: `p${n}::ac0`,
				external_source: "planestories",
				state: { group: "backlog" },
			});
		}
		const fake = makeFakeClient({
			projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
			states: {
				[PROJECT]: [
					{ id: "done", name: "Done", group: "completed" },
					{ id: "backlog", name: "Backlog", group: "backlog" },
				],
			},
			workItems: { [PROJECT]: items },
		});

		const seen: string[] = [];
		for (let run = 0; run < 3; run++) {
			const r = await migrateCriteria(fake.client, {
				config,
				project: "Proj",
				apply: true,
				limit: 1,
			});
			for (const p of r.migrated) {
				seen.push(p.identifier);
			}
		}
		// Each run migrates the NEXT parent — not the same one stuck at the front.
		expect(seen).toEqual(["ENG-1", "ENG-3", "ENG-5"]);
	});
});

describe("checkCriteriaMigration (doctor drift)", () => {
	test("flags an unmigrated parent (::ac children, no description checklist)", async () => {
		const fake = makeFakeClient(boardData());
		const index = await fetchProjectIndex(fake.client, PROJECT, "ENG");
		const drift = checkCriteriaMigration(index, "ENG");
		expect(drift.unmigrated.map((r) => r.identifier)).toEqual(["ENG-1"]);
		expect(drift.dual).toHaveLength(0);
	});

	test("flags a dual parent (description checklist AND an open ::ac child)", async () => {
		const fake = makeFakeClient({
			projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
			workItems: {
				[PROJECT]: [
					{
						id: "parent",
						sequence_id: 1,
						name: "Parent",
						description_html: TASKLIST_HTML,
						state: { group: "backlog" },
					},
					{
						id: "c0",
						sequence_id: 2,
						name: "c",
						parent: "parent",
						external_id: "parent::ac0",
						external_source: "planestories",
						state: { group: "backlog" }, // still OPEN
					},
				],
			},
		});
		const index = await fetchProjectIndex(fake.client, PROJECT, "ENG");
		const drift = checkCriteriaMigration(index, "ENG");
		expect(drift.unmigrated).toHaveLength(0);
		expect(drift.dual.map((r) => r.identifier)).toEqual(["ENG-1"]);
		expect(drift.dual[0]?.openChildren).toBe(1);
	});

	test("a fully-migrated parent (checklist, all children closed) is clean", async () => {
		const fake = makeFakeClient({
			projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
			workItems: {
				[PROJECT]: [
					{
						id: "parent",
						sequence_id: 1,
						name: "Parent",
						description_html: TASKLIST_HTML,
						state: { group: "backlog" },
					},
					{
						id: "c0",
						sequence_id: 2,
						name: "c",
						parent: "parent",
						external_id: "parent::ac0",
						external_source: "planestories",
						state: { group: "completed" }, // closed
					},
				],
			},
		});
		const index = await fetchProjectIndex(fake.client, PROJECT, "ENG");
		const drift = checkCriteriaMigration(index, "ENG");
		expect(drift.unmigrated).toHaveLength(0);
		expect(drift.dual).toHaveLength(0);
	});
});
