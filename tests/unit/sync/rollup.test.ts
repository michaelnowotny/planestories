import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/errors.ts";
import { rollupEpic } from "../../../src/sync/rollup.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "aaaaaaaa-2222-3333-4444-555555555555";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Data Platform",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

const started = { id: "s1", name: "In Progress", group: "started" };
const backlog = { id: "s2", name: "Backlog", group: "backlog" };
const done = { id: "s3", name: "Done", group: "completed" };
const cancelled = { id: "s4", name: "Cancelled", group: "cancelled" };
const effortHtml = (n: string) => `<p><strong>Effort:</strong> ${n} dev-days</p>`;

function board(items: Array<Record<string, unknown>>): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
		workItems: { [PROJECT_UUID]: items },
	};
}

describe("rollupEpic", () => {
	test("summarizes stories, completion %, effort, and status breakdown", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{
					id: "a",
					sequence_id: 2,
					name: "A",
					parent: "e",
					state: done,
					description_html: effortHtml("2"),
				},
				{
					id: "b",
					sequence_id: 3,
					name: "B",
					parent: "e",
					state: backlog,
					description_html: effortHtml("3"),
				},
			]),
		);
		const { rollup, text } = await rollupEpic(client, { config, identifier: "DATA-1" });

		expect(rollup.leafTotal).toBe(2);
		expect(rollup.completed).toBe(1);
		expect(rollup.completionPct).toBe(50); // 1 of 2 active
		expect(rollup.totalEffortDays).toBe(5);
		expect(rollup.missingEffort).toBe(0);
		expect(rollup.byStateGroup).toEqual({ completed: 1, backlog: 1 });
		expect(text).toContain("50% complete");
		expect(text).toContain("Effort: 5 dev-days");
	});

	test("cancelled stories are excluded from the completion denominator", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{ id: "a", sequence_id: 2, name: "A", parent: "e", state: done },
				{ id: "b", sequence_id: 3, name: "B", parent: "e", state: cancelled },
			]),
		);
		const { rollup } = await rollupEpic(client, { config, identifier: "DATA-1" });
		// 1 completed of 1 active (the cancelled one is not active) = 100%.
		expect(rollup.cancelled).toBe(1);
		expect(rollup.completionPct).toBe(100);
	});

	test("completion is null when there is no active work (all cancelled / no leaves)", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{ id: "a", sequence_id: 2, name: "A", parent: "e", state: cancelled },
			]),
		);
		const { rollup, text } = await rollupEpic(client, { config, identifier: "DATA-1" });
		expect(rollup.completionPct).toBeNull();
		expect(text).toContain("n/a complete");
	});

	test("effort is a lower bound with a count when a story is unestimated", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{
					id: "a",
					sequence_id: 2,
					name: "A",
					parent: "e",
					state: backlog,
					description_html: effortHtml("2"),
				},
				{ id: "b", sequence_id: 3, name: "B", parent: "e", state: backlog }, // no effort
			]),
		);
		const { rollup, text } = await rollupEpic(client, { config, identifier: "DATA-1" });
		expect(rollup.totalEffortDays).toBe(2);
		expect(rollup.missingEffort).toBe(1);
		expect(text).toContain("lower bound");
	});

	test("float effort sums cleanly (no IEEE noise)", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{
					id: "a",
					sequence_id: 2,
					name: "A",
					parent: "e",
					state: backlog,
					description_html: effortHtml("0.1"),
				},
				{
					id: "b",
					sequence_id: 3,
					name: "B",
					parent: "e",
					state: backlog,
					description_html: effortHtml("0.2"),
				},
			]),
		);
		const { text } = await rollupEpic(client, { config, identifier: "DATA-1" });
		expect(text).toContain("0.3 dev-days");
		expect(text).not.toContain("0.30000");
	});

	test("counts the whole subtree (nested epics) and reports sub-epics + blocked/blocking", async () => {
		// C is blocked by D (D blocks C), seeded via the fake client's relations map.
		const { client } = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "A", sequence_id: 1, name: "Epic A", state: started },
					{ id: "B", sequence_id: 2, name: "Epic B", parent: "A", state: started },
					{ id: "C", sequence_id: 3, name: "Story C", parent: "B", state: backlog },
					{ id: "D", sequence_id: 4, name: "Story D", parent: "A", state: backlog },
				],
			},
			relations: { C: { blocked_by: ["D"] } },
		});
		const { rollup } = await rollupEpic(client, { config, identifier: "DATA-1" });
		expect(rollup.subEpics).toBe(1); // Epic B
		expect(rollup.leafTotal).toBe(2); // Story C + Story D
		expect(rollup.blocked.map((c) => c.identifier)).toEqual(["DATA-3"]); // C is blocked
		expect(rollup.blocking.map((c) => c.identifier)).toEqual(["DATA-4"]); // D blocks
	});

	test("a non-epic target is a clear error", async () => {
		const { client } = makeFakeClient(
			board([{ id: "solo", sequence_id: 9, name: "Lonely story", state: backlog }]),
		);
		await expect(rollupEpic(client, { config, identifier: "DATA-9" })).rejects.toBeInstanceOf(
			ConfigError,
		);
	});

	test("an unknown identifier is a clear error", async () => {
		const { client } = makeFakeClient(
			board([
				{ id: "e", sequence_id: 1, name: "Epic", state: started },
				{ id: "a", sequence_id: 2, name: "A", parent: "e", state: backlog },
			]),
		);
		await expect(rollupEpic(client, { config, identifier: "DATA-404" })).rejects.toBeInstanceOf(
			ConfigError,
		);
	});
});
