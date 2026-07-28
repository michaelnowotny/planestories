import { describe, expect, test } from "bun:test";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { checkDependencyGraph } from "../../../src/sync/graph_check.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "aaaaaaaa-3333-4444-5555-666666666666";

async function run(data: FakeData) {
	const { client } = makeFakeClient(data);
	const index = await fetchProjectIndex(client, PROJECT_UUID, "DATA");
	return checkDependencyGraph(client, PROJECT_UUID, "DATA", index);
}

describe("checkDependencyGraph (dangling relations)", () => {
	test("flags a relation whose target isn't in the project", async () => {
		const report = await run({
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "wi-a", sequence_id: 1, name: "A" },
					{ id: "wi-b", sequence_id: 2, name: "B" },
				],
			},
			// A is blocked_by a ghost (deleted) item and by B (present).
			relations: { "wi-a": { blocked_by: ["ghost-uuid", "wi-b"] } },
		});
		expect(report.dangling).toHaveLength(1);
		expect(report.dangling[0]).toEqual({
			from: "DATA-1",
			relation: "blocked_by",
			targetId: "ghost-uuid",
		});
	});

	test("reports nothing when every relation resolves", async () => {
		const report = await run({
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "wi-a", sequence_id: 1, name: "A" },
					{ id: "wi-b", sequence_id: 2, name: "B" },
				],
			},
			relations: { "wi-a": { blocked_by: ["wi-b"] } },
		});
		expect(report.dangling).toHaveLength(0);
	});

	test("a symmetric relates_to dangling edge is reported once, not twice", async () => {
		const report = await run({
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [{ id: "wi-a", sequence_id: 1, name: "A" }],
			},
			relations: { "wi-a": { relates_to: ["ghost-uuid"] } },
		});
		expect(report.dangling.filter((d) => d.relation === "relates_to")).toHaveLength(1);
	});

	test("criterion sub-items are not scanned for relations", async () => {
		const report = await run({
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "wi-p", sequence_id: 1, name: "Parent" },
					{
						id: "wi-ac",
						sequence_id: 2,
						name: "a criterion",
						parent: "wi-p",
						external_source: "planestories",
						external_id: "p::ac0",
					},
				],
			},
			// Even if a criterion somehow carried a dangling relation, it's not scanned.
			relations: { "wi-ac": { blocked_by: ["ghost-uuid"] } },
		});
		expect(report.dangling).toHaveLength(0);
	});
});
