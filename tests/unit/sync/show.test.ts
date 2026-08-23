import { describe, expect, test } from "bun:test";
import { buildAtlasFromBoard } from "../../../src/atlas/model.ts";
import { ConfigError } from "../../../src/errors.ts";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { buildShowItem, renderShowText } from "../../../src/sync/show.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT = "project-1";

async function fixture() {
	const { client } = makeFakeClient({
		projects: [{ id: PROJECT, name: "Data Platform", identifier: "DATA" }],
		workItems: {
			[PROJECT]: [
				{
					id: "root",
					sequence_id: 1,
					name: "Parent bucket",
					state: { name: "In Progress", group: "started" },
				},
				{
					id: "target",
					sequence_id: 2,
					name: "Target initiative",
					parent: "root",
					description_html:
						"<p>Body that show must not print.</p><p><strong>Effort:</strong> 2.5 dev-days</p>",
					priority: "urgent",
					labels: [{ name: "retirement" }, { name: "finance" }],
					assignees: [{ email: "operator@example.test" }],
					state: { name: "In Progress", group: "started" },
				},
				{
					id: "child-done",
					sequence_id: 3,
					name: "Finished child",
					parent: "target",
					state: { name: "Done", group: "completed" },
				},
				{
					id: "child-open",
					sequence_id: 4,
					name: "Open child",
					parent: "target",
					state: { name: "Backlog", group: "backlog" },
				},
				{
					id: "blocker",
					sequence_id: 5,
					name: "The actual prerequisite",
					state: { name: "Done", group: "completed" },
				},
				{
					id: "downstream",
					sequence_id: 6,
					name: "Downstream consumer",
					state: { name: "Todo", group: "unstarted" },
				},
				{
					id: "peer",
					sequence_id: 7,
					name: "Peer investigation",
					state: { name: "Review", group: "started" },
				},
			],
		},
		relations: {
			target: { blocked_by: ["blocker"], blocking: ["downstream"], relates_to: ["peer"] },
		},
	});
	const index = await fetchProjectIndex(client, PROJECT, "DATA");
	const targetRelations = await client.getRelations(PROJECT, "target");
	const graph = buildAtlasFromBoard(
		client,
		PROJECT,
		"DATA",
		"Data Platform",
		index,
		new Map([["target", targetRelations]]),
	);
	return graph;
}

describe("buildShowItem", () => {
	test("projects one item with parent/child detail and titled relation counterparts", async () => {
		const graph = await fixture();
		const item = buildShowItem(graph, "data-2", { kind: "complete" });

		expect(item).toMatchObject({
			identifier: "DATA-2",
			title: "Target initiative",
			status: "In Progress",
			effortDays: 2.5,
			priority: "urgent",
			assignee: "operator@example.test",
			labels: ["retirement", "finance"],
			parent: { identifier: "DATA-1", title: "Parent bucket" },
			criteria: { completed: 0, total: 0 },
		});
		expect(item.directChildren).toEqual({
			total: 2,
			byStatus: [
				{ status: "Backlog", count: 1 },
				{ status: "Done", count: 1 },
			],
		});
		expect(item.relations.blockedBy[0]).toMatchObject({
			identifier: "DATA-5",
			title: "The actual prerequisite",
			status: "Done",
		});
		expect(item.relations.blocks[0]?.title).toBe("Downstream consumer");
		expect(item.relations.relatesTo[0]?.title).toBe("Peer investigation");
	});

	test("renders a compact answer without the description body", async () => {
		const item = buildShowItem(await fixture(), "DATA-2", { kind: "complete" });
		const text = renderShowText(item, "Data Platform board · test source");

		expect(text.split("\n")).toHaveLength(6);
		expect(text).toContain("DATA-2 — Target initiative");
		expect(text).toContain("Parent bucket");
		expect(text).toContain("The actual prerequisite [Done]");
		expect(text).toContain("Children: 2 (Backlog 1, Done 1)");
		expect(text).not.toContain("Body that show must not print");
	});

	test("labels a partial relation sweep instead of publishing observed edges as complete", async () => {
		const item = buildShowItem(await fixture(), "DATA-2", { kind: "partial", failures: 2 });
		const text = renderShowText(item, "Data Platform board · test source");

		expect(item.dependencyCoverage).toEqual({ kind: "partial", failures: 2 });
		expect(text).toContain("Relations (partial: 2 lookups failed)");
	});

	test("an unknown identifier fails clearly and names the board", async () => {
		const graph = await fixture();
		expect(() => buildShowItem(graph, "DATA-404", { kind: "complete" })).toThrow(ConfigError);
		try {
			buildShowItem(graph, "DATA-404", { kind: "complete" });
		} catch (error) {
			expect((error as Error).message).toContain("DATA-404");
			expect((error as Error).message).toContain("Data Platform");
		}
	});
});
