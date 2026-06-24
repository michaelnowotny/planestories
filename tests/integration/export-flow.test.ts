import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownFile } from "../../src/markdown/parser.ts";
import { exportStories } from "../../src/sync/exporter.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "test-api-key",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
};

function data(): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		workItems: {
			[PROJECT_UUID]: [
				{
					id: "wi-1",
					sequence_id: 8,
					name: "Log in",
					description_stripped: "User can log in.",
					priority: "high",
					point: 3,
					state: { id: "s1", name: "Backlog" },
					assignees: [{ id: "u1", email: "jane@co.com", display_name: "jane" }],
					labels: [{ id: "l1", name: "Feature" }],
				},
			],
		},
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "export-flow-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("export flow (end to end)", () => {
	test("exports work items to markdown that parses back into a matching story", async () => {
		const { client } = makeFakeClient(data());
		const outputPath = join(tmpDir, "export.md");

		const result = await exportStories(client, { config, filters: {}, outputPath });
		expect(result.count).toBe(1);

		// Round-trip: the exported markdown should parse cleanly.
		const content = readFileSync(outputPath, "utf-8");
		const parsed = parseMarkdownFile(content, outputPath);

		expect(parsed.frontmatter.project).toBe("Q1 Release");
		expect(parsed.stories).toHaveLength(1);

		const story = parsed.stories[0]!;
		expect(story.title).toBe("Log in");
		expect(story.planeIdentifier).toBe("ENG-8");
		expect(story.priority).toBe("high");
		expect(story.status).toBe("Backlog");
		expect(story.assignee).toBe("jane@co.com");
		expect(story.labels).toEqual(["Feature"]);
		expect(story.estimate).toBe(3);
	});
});
