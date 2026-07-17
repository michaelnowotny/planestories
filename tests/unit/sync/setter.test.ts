import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/errors.ts";
import { setWorkItems } from "../../../src/sync/setter.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function data(): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		states: {
			[PROJECT_UUID]: [
				{ id: "s-backlog", name: "Backlog" },
				{ id: "s-progress", name: "In Progress" },
			],
		},
		workItems: { [PROJECT_UUID]: [{ id: "wi-12", sequence_id: 12, name: "Item" }] },
	};
}

describe("setWorkItems", () => {
	test("requires at least one field", async () => {
		const { client } = makeFakeClient(data());
		expect(setWorkItems(client, { config, identifiers: ["ENG-12"] })).rejects.toThrow(ConfigError);
	});

	test("requires a project", async () => {
		const { client } = makeFakeClient(data());
		expect(
			setWorkItems(client, {
				config: { ...config, defaultProject: null },
				identifiers: ["ENG-12"],
				status: "Backlog",
			}),
		).rejects.toThrow(ConfigError);
	});

	test("updates state by identifier", async () => {
		const { client, updatedItems } = makeFakeClient(data());

		const summary = await setWorkItems(client, {
			config,
			identifiers: ["ENG-12"],
			status: "In Progress",
		});

		expect(summary.updated).toBe(1);
		expect(updatedItems).toHaveLength(1);
		expect(updatedItems[0]!.workItemId).toBe("wi-12");
		expect(updatedItems[0]!.body.state).toBe("s-progress");
	});

	test("reports failure for an unknown identifier", async () => {
		const { client } = makeFakeClient(data());

		const summary = await setWorkItems(client, {
			config,
			identifiers: ["ENG-99"],
			priority: "high",
		});

		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.error).toContain("not found");
	});
});
