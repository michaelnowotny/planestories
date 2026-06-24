import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../../src/errors.ts";
import { exportStories } from "../../../src/sync/exporter.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "test-api-key",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
};

function dataWithItems(): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		workItems: {
			[PROJECT_UUID]: [
				{
					id: "wi-1",
					sequence_id: 8,
					name: "Log in",
					description_html:
						'<p>User can log in.</p><h3>Acceptance Criteria</h3><ul><li><input type="checkbox"> enters email</li></ul>',
					priority: "high",
					point: 3,
					state: { id: "s1", name: "Backlog" },
					assignees: [{ id: "u1", email: "jane@co.com", display_name: "jane" }],
					labels: [{ id: "l1", name: "Feature" }],
					external_source: "planestories",
				},
				{
					id: "wi-2",
					sequence_id: 9,
					name: "Sign up",
					priority: "none",
					state: { id: "s2", name: "Done" },
					assignees: [],
					labels: [],
				},
			],
		},
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "exporter-test-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("exportStories", () => {
	test("writes resolved work items to a markdown file", async () => {
		const { client } = makeFakeClient(dataWithItems());
		const outputPath = join(tmpDir, "out.md");

		const result = await exportStories(client, { config, filters: {}, outputPath });

		expect(result.count).toBe(2);
		const md = readFileSync(outputPath, "utf-8");
		expect(md).toContain('project: "Q1 Release"');
		expect(md).toContain("## Log in");
		expect(md).toContain("plane_identifier: ENG-8");
		expect(md).toContain("priority: high");
		expect(md).toContain("status: Backlog");
		expect(md).toContain("assignee: jane@co.com");
		expect(md).toContain("labels: [Feature]");
		// Body HTML is converted back to markdown, including the AC checklist.
		expect(md).toContain("### Acceptance Criteria");
		expect(md).toContain("- [ ] enters email");
		// 'none' priority is not written
		expect(md).toContain("## Sign up");
	});

	test("filters by status", async () => {
		const { client } = makeFakeClient(dataWithItems());
		const outputPath = join(tmpDir, "out.md");

		const result = await exportStories(client, {
			config,
			filters: { status: "Done" },
			outputPath,
		});

		expect(result.count).toBe(1);
		const md = readFileSync(outputPath, "utf-8");
		expect(md).toContain("## Sign up");
		expect(md).not.toContain("## Log in");
	});

	test("exports in ascending sequence_id order", async () => {
		// data() lists wi-1 (seq 8) then wi-2 (seq 9); prepend an out-of-order item.
		const d = dataWithItems();
		const earliest = {
			id: "wi-0",
			sequence_id: 3,
			name: "Earliest",
			priority: "none",
			state: { id: "s", name: "Todo" },
			assignees: [],
			labels: [],
		};
		d.workItems = { [PROJECT_UUID]: [earliest, ...(d.workItems?.[PROJECT_UUID] ?? [])] };
		const { client } = makeFakeClient(d);
		const outputPath = join(tmpDir, "out.md");

		await exportStories(client, { config, filters: {}, outputPath });
		const md = readFileSync(outputPath, "utf-8");
		// "Earliest" (seq 3) must appear before "Log in" (seq 8).
		expect(md.indexOf("## Earliest")).toBeLessThan(md.indexOf("## Log in"));
	});

	test("filters by external_source", async () => {
		const { client } = makeFakeClient(dataWithItems());
		const outputPath = join(tmpDir, "out.md");

		const result = await exportStories(client, {
			config,
			filters: { externalSource: "planestories" },
			outputPath,
		});

		// Only wi-1 carries external_source: planestories.
		expect(result.count).toBe(1);
		expect(readFileSync(outputPath, "utf-8")).toContain("## Log in");
	});

	test("--sync-criteria folds sub-items into the parent's checklist and hides them as stories", async () => {
		const { client } = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: {
				[PROJECT_UUID]: [
					{
						id: "p1",
						sequence_id: 5,
						name: "Parent story",
						description_html: "<p>Narrative.</p>",
						state: { id: "s1", name: "Backlog", group: "backlog" },
						assignees: [],
						labels: [],
						external_source: "planestories",
					},
					{
						id: "c0",
						sequence_id: 6,
						name: "first criterion",
						parent: "p1",
						external_id: "parent-story::ac0",
						state: { id: "s2", name: "Backlog", group: "unstarted" },
						assignees: [],
						labels: [],
						external_source: "planestories",
					},
					{
						id: "c1",
						sequence_id: 7,
						name: "second criterion",
						parent: "p1",
						external_id: "parent-story::ac1",
						state: { id: "s3", name: "Done", group: "completed" },
						assignees: [],
						labels: [],
						external_source: "planestories",
					},
				],
			},
		});
		const outputPath = join(tmpDir, "out.md");

		const result = await exportStories(client, {
			config,
			filters: {},
			outputPath,
			syncCriteria: true,
		});

		// Only the parent is a story; the two children are folded in.
		expect(result.count).toBe(1);
		const md = readFileSync(outputPath, "utf-8");
		expect(md).toContain("## Parent story");
		expect(md).not.toContain("## first criterion");
		expect(md).toContain("### Acceptance Criteria");
		expect(md).toContain("- [ ] first criterion");
		expect(md).toContain("- [x] second criterion");
	});

	test("throws when no project can be resolved", async () => {
		const { client } = makeFakeClient(dataWithItems());
		const outputPath = join(tmpDir, "out.md");

		expect(
			exportStories(client, {
				config: { ...config, defaultProject: null },
				filters: {},
				outputPath,
			}),
		).rejects.toThrow(ConfigError);
	});
});
