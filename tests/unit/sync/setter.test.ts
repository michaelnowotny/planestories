import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/errors.ts";
import { evidenceMarker, setWorkItems } from "../../../src/sync/setter.ts";
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

describe("evidence log (--evidence)", () => {
	test("evidence-only: posts a comment and does NOT patch the work item", async () => {
		const { client, updatedItems, createdComments } = makeFakeClient(data());
		const summary = await setWorkItems(client, {
			config,
			identifiers: ["ENG-12"],
			evidence: "deployed abc123; p95 200ms -> 80ms",
		});
		expect(summary.updated).toBe(1);
		expect(summary.results[0]?.evidence).toBe("posted");
		expect(updatedItems).toHaveLength(0); // no field change => no PATCH
		expect(createdComments).toHaveLength(1);
	});

	test("re-posting the SAME evidence is idempotent (append-only, deduped)", async () => {
		const shared = data();
		const { client, createdComments } = makeFakeClient(shared);
		const opts = { config, identifiers: ["ENG-12"], evidence: "shipped def456" };
		const first = await setWorkItems(client, opts);
		const second = await setWorkItems(client, opts);
		expect(first.results[0]?.evidence).toBe("posted");
		expect(second.results[0]?.evidence).toBe("exists"); // not re-posted
		expect(createdComments).toHaveLength(1); // only one comment total
	});

	test("DIFFERENT evidence appends a new comment", async () => {
		const shared = data();
		const { client, createdComments } = makeFakeClient(shared);
		await setWorkItems(client, { config, identifiers: ["ENG-12"], evidence: "one" });
		await setWorkItems(client, { config, identifiers: ["ENG-12"], evidence: "two" });
		expect(createdComments).toHaveLength(2);
	});

	test("status + evidence: patches the state AND posts evidence", async () => {
		const { client, updatedItems, createdComments } = makeFakeClient(data());
		const summary = await setWorkItems(client, {
			config,
			identifiers: ["ENG-12"],
			status: "In Progress",
			evidence: "moved to In Progress in commit abc",
		});
		expect(updatedItems[0]?.body.state).toBe("s-progress");
		expect(createdComments).toHaveLength(1);
		expect(summary.results[0]?.evidence).toBe("posted");
	});

	test("evidenceMarker is content-derived (stable per text, differs across text)", () => {
		expect(evidenceMarker("same")).toBe(evidenceMarker(" same ")); // trimmed
		expect(evidenceMarker("a")).not.toBe(evidenceMarker("b"));
	});

	test("evidenceMarker is bracketed + fixed 16-hex width (no prefix-collision under substring search)", () => {
		// ensureComment uses includes(); an unpadded/unbracketed marker could be a prefix
		// of a longer one and falsely dedup. Brackets + fixed width make that impossible.
		const m = evidenceMarker("x");
		expect(m).toMatch(/^\[planestories:evidence:[0-9a-f]{16}\]$/);
		// No marker can be a prefix of another (all same length, both bracket-terminated).
		expect(evidenceMarker("a").length).toBe(evidenceMarker("bb").length);
	});

	test("a whitespace-only --evidence note is rejected, not posted empty", async () => {
		const { client } = makeFakeClient(data());
		await expect(
			setWorkItems(client, { config, identifiers: ["ENG-12"], evidence: "   " }),
		).rejects.toBeInstanceOf(ConfigError);
	});
});
