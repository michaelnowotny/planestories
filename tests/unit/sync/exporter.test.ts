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
	sourceLabel: null,
	maxRetries: 5,
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
		const data = dataWithItems();
		data.relations = {
			"wi-1": { blocked_by: ["wi-2"], relates_to: ["wi-2"] },
			"wi-2": { blocking: ["wi-1"], relates_to: ["wi-1"] },
		};
		const { client } = makeFakeClient(data);
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
		expect(md).toContain("blocked_by: [ENG-9]");
		expect(md).toContain("relates_to: [ENG-9]");
		expect(md).toContain("blocks: [ENG-8]");
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

	test("excludes archived items by default; --include-archived keeps them", async () => {
		const make = () =>
			makeFakeClient({
				projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
				workItems: {
					[PROJECT_UUID]: [
						{
							id: "a",
							sequence_id: 1,
							name: "Active",
							state: { id: "s", name: "Todo" },
							assignees: [],
							labels: [],
						},
						{
							id: "b",
							sequence_id: 2,
							name: "Archived one",
							state: { id: "s", name: "Done" },
							assignees: [],
							labels: [{ id: "l", name: "archived" }],
						},
					],
				},
			});

		const out = join(tmpDir, "out.md");
		const def = await exportStories(make().client, { config, filters: {}, outputPath: out });
		expect(def.count).toBe(1);
		expect(readFileSync(out, "utf-8")).not.toContain("## Archived one");

		const all = await exportStories(make().client, {
			config,
			filters: {},
			outputPath: out,
			includeArchived: true,
		});
		expect(all.count).toBe(2);
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

describe("export --orphans-only (orphan worksheet)", () => {
	function orphanBoard(): FakeData {
		return {
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: {
				[PROJECT_UUID]: [
					{
						id: "epic-1",
						sequence_id: 1,
						name: "The epic",
						state: { id: "s1", name: "Backlog", group: "backlog" },
					},
					{
						id: "child-1",
						sequence_id: 2,
						name: "Filed story",
						parent: "epic-1",
						state: { id: "s1", name: "Backlog", group: "backlog" },
					},
					{
						id: "orphan-1",
						sequence_id: 3,
						name: "Unfiled story",
						state: { id: "s1", name: "Backlog", group: "backlog" },
					},
					{
						id: "crit-1",
						sequence_id: 4,
						name: "a criterion",
						parent: "child-1",
						external_id: "filed::ac0",
						external_source: "planestories",
						state: { id: "s2", name: "Done", group: "completed" },
					},
				],
			},
		};
	}

	test("emits only parentless non-epics, with an epics directory header", async () => {
		const { client } = makeFakeClient(orphanBoard());
		const outputPath = join(tmpDir, "orphans.md");
		const result = await exportStories(client, {
			config,
			filters: {},
			project: "Q1 Release",
			outputPath,
			orphansOnly: true,
		});
		expect(result.count).toBe(1);
		const md = readFileSync(outputPath, "utf8");
		// Only the orphan story is exported…
		expect(md).toContain("Unfiled story");
		expect(md).not.toContain("## The epic");
		expect(md).not.toContain("Filed story");
		expect(md).not.toContain("a criterion");
		// …with the epics directory as inert YAML comments in the frontmatter.
		expect(md).toContain("# ORPHAN WORKSHEET");
		expect(md).toContain("#   EPIC ENG-1 - The epic");
	});

	test("the worksheet round-trips: comments are inert to the parser", async () => {
		const { client } = makeFakeClient(orphanBoard());
		const outputPath = join(tmpDir, "orphans.md");
		await exportStories(client, {
			config,
			filters: {},
			project: "Q1 Release",
			outputPath,
			orphansOnly: true,
		});
		const md = readFileSync(outputPath, "utf8");
		const { parseMarkdownFile } = await import("../../../src/markdown/parser.ts");
		const parsed = parseMarkdownFile(md, outputPath);
		expect(parsed.frontmatter.project).toBe("Q1 Release");
		expect(parsed.stories.length).toBe(1);
		expect(parsed.stories[0]?.title).toBe("Unfiled story");
		expect(parsed.stories[0]?.parent).toBeNull();
	});
});

describe("export relation-fetch resilience (sweep + fail-hard)", () => {
	test("a transiently rate-limited relation lookup is recovered by the sweep", async () => {
		const { client } = makeFakeClient(dataWithItems());
		let failures = 1;
		const flaky = Object.create(client);
		flaky.getRelations = async (projectId: string, itemId: string) => {
			if (failures > 0) {
				failures--;
				throw new Error("429 simulated");
			}
			return client.getRelations(projectId, itemId);
		};
		const outputPath = join(tmpDir, "sweep.md");
		const result = await exportStories(flaky, {
			config,
			filters: {},
			project: "Q1 Release",
			outputPath,
		});
		expect(result.count).toBe(2); // both stories exported despite the first-pass failure
	});

	test("persistently failing relations ABORT the export (no silently thin file)", async () => {
		const { client } = makeFakeClient(dataWithItems());
		const broken = Object.create(client);
		broken.getRelations = async () => {
			throw new Error("429 forever");
		};
		const outputPath = join(tmpDir, "broken.md");
		await expect(
			exportStories(broken, { config, filters: {}, project: "Q1 Release", outputPath }),
		).rejects.toThrow("export aborted");
	});
});

describe("an empty export explains ITSELF", () => {
	// "Exported 0 stories", printed green with exit 0, is what a wrong-instance or
	// wrong-project run produces — and it is indistinguishable from a genuinely
	// empty board. The finance session lost a detour to exactly that. The exporter
	// now returns enough for the caller to tell the two apart.

	test("reports the project's TRUE item count, so an empty index is visible", async () => {
		const fake = makeFakeClient({
			projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
			workItems: { [PROJECT_UUID]: [] },
		});
		const result = await exportStories(fake.client, {
			config,
			filters: {},
			outputPath: join(tmpDir, "out.md"),
		});
		expect(result.count).toBe(0);
		// 0 items in the index => "wrong board", not "board with nothing matching".
		expect(result.projectItemCount).toBe(0);
	});

	test("a populated project with excluding filters is a DIFFERENT zero", async () => {
		const fake = makeFakeClient(dataWithItems());
		const result = await exportStories(fake.client, {
			config,
			filters: { status: "NoSuchState" },
			outputPath: join(tmpDir, "out2.md"),
		});
		expect(result.count).toBe(0);
		// The board was really observed and really has items — the filters did this.
		expect(result.projectItemCount).toBeGreaterThan(0);
	});

	test("identifiers that do not exist here are named, not silently dropped", async () => {
		// The existence-guard case: DATA-2569 was inherited from a handover, did not
		// exist, and propagated into four documents before anyone checked.
		const fake = makeFakeClient(dataWithItems());
		const result = await exportStories(fake.client, {
			config,
			filters: { issues: ["ENG-8", "ENG-9999"] },
			outputPath: join(tmpDir, "out3.md"),
		});
		expect(result.unmatchedIdentifiers).toEqual(["ENG-9999"]);
	});

	test("every requested identifier matching leaves nothing unmatched", async () => {
		const fake = makeFakeClient(dataWithItems());
		const result = await exportStories(fake.client, {
			config,
			filters: { issues: ["ENG-8"] },
			outputPath: join(tmpDir, "out4.md"),
		});
		expect(result.count).toBeGreaterThan(0);
		expect(result.unmatchedIdentifiers).toEqual([]);
	});
});
