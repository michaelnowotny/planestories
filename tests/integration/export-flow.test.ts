import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownFile } from "../../src/markdown/parser.ts";
import { exportStories } from "../../src/sync/exporter.ts";
import { importStories } from "../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "test-api-key",
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
		// The acceptance-criteria checklist survives the HTML round-trip.
		expect(story.body).toContain("### Acceptance Criteria");
		expect(story.body).toContain("- [ ] enters email");
	});

	test("folds a legacy criterion child into its parent — never a standalone story", async () => {
		const { client } = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "p", sequence_id: 10, name: "Parent story", state: { name: "Backlog" } },
					{
						id: "c",
						sequence_id: 11,
						name: "a criterion",
						parent: "p",
						external_id: "parent-story::ac0",
						external_source: "planestories",
						state: { name: "Backlog", group: "backlog" },
					},
				],
			},
		});
		const outputPath = join(tmpDir, "kind.md");

		// Owned `::ac<n>` children are UNCONDITIONALLY excluded (Codex #8): the parent
		// (which has no description checklist) folds the child in as a criterion.
		await exportStories(client, { config, filters: {}, outputPath });
		const content = readFileSync(outputPath, "utf-8");

		expect(content).not.toContain("kind: criterion");
		expect(content).not.toContain("## a criterion");
		// The parent story carries the folded criterion as its checklist.
		expect(content).toContain("## Parent story");
		expect(content).toContain("### Acceptance Criteria");
		expect(content).toContain("- [ ] a criterion");
	});

	test("description-first: a migrated parent ignores its leftover completed children", async () => {
		// A parent that already has a TipTap task-list in its description (an UNCHECKED
		// criterion) AND a legacy `::ac0` child that migrate left behind in a COMPLETED
		// state. Precedence (design §2) must take the description (unchecked), not the
		// child (which would render as checked) — keying off the description checklist,
		// not "has no children".
		const { client } = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: {
				[PROJECT_UUID]: [
					{
						id: "p",
						sequence_id: 10,
						name: "Migrated story",
						description_html:
							'<p>Body.</p><h3>Acceptance Criteria</h3><ul class="todo-list" data-type="taskList"><li data-type="taskItem" data-checked="false"><p>the real criterion</p></li></ul>',
						state: { name: "Backlog" },
					},
					{
						id: "c",
						sequence_id: 11,
						name: "the real criterion",
						parent: "p",
						external_id: "migrated-story::ac0",
						external_source: "planestories",
						state: { name: "Done", group: "completed" },
					},
				],
			},
		});
		const outputPath = join(tmpDir, "migrated.md");
		await exportStories(client, { config, filters: {}, outputPath });
		const content = readFileSync(outputPath, "utf-8");

		expect(content).not.toContain("## the real criterion"); // child excluded
		expect(content).toContain("- [ ] the real criterion"); // description state wins (unchecked)
		expect(content).not.toContain("- [x] the real criterion"); // NOT the completed child's state
	});

	test("emits kind: epic for an item that parents a non-criterion child story", async () => {
		const { client } = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: {
				[PROJECT_UUID]: [
					{ id: "ep", sequence_id: 20, name: "The Epic", state: { name: "Backlog" } },
					{
						id: "st",
						sequence_id: 21,
						name: "A child story",
						parent: "ep",
						state: { name: "Backlog" },
					},
				],
			},
		});
		const outputPath = join(tmpDir, "epic.md");

		await exportStories(client, { config, filters: {}, outputPath });
		const content = readFileSync(outputPath, "utf-8");

		// The parent (parents a real story) is emitted as an epic.
		const epicBlock = content.slice(
			content.indexOf("## The Epic"),
			content.indexOf("## A child story"),
		);
		expect(epicBlock).toContain("kind: epic");
		// The child links to the epic and stays a plain story (no noisy kind line).
		const childBlock = content.slice(content.indexOf("## A child story"));
		expect(childBlock).toContain("parent: ENG-20");
		expect(childBlock).not.toContain("kind:");
	});

	test("exported files carry plane_hash so a re-import starts warm (unchanged, zero writes)", async () => {
		const outputPath = join(tmpDir, "export.md");

		const exportClient = makeFakeClient(data());
		await exportStories(exportClient.client, { config, filters: {}, outputPath });

		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("plane_hash: ");

		// Re-importing the just-exported file must not blind-rewrite anything.
		const importClient = makeFakeClient(data());
		const summary = await importStories(importClient.client, { files: [outputPath], config });

		expect(summary.created).toBe(0);
		expect(summary.updated).toBe(0);
		expect(summary.unchanged).toBe(1);
		expect(importClient.createdItems).toHaveLength(0);
		expect(importClient.updatedItems).toHaveLength(0);
	});
});
