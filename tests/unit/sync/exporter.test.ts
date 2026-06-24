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
