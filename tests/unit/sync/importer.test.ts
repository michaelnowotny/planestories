import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStories, makeExternalId } from "../../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const PLANE_UUID = "11111111-1111-4111-8111-111111111111";

const defaultConfig: ResolvedConfig = {
	apiKey: "test-api-key",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

/** Fake-client data with a project, label, state and member that all resolve. */
function baseData(extra: Partial<FakeData> = {}): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		labels: {
			[PROJECT_UUID]: [
				{ id: "lbl-feature", name: "Feature" },
				{ id: "lbl-default", name: "DefaultLabel" },
			],
		},
		states: { [PROJECT_UUID]: [{ id: "state-backlog", name: "Backlog" }] },
		members: {
			[PROJECT_UUID]: [{ id: "user-1", email: "jane@company.com", display_name: "jane" }],
		},
		...extra,
	};
}

const markdownNewStories = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
priority: high
labels: [Feature]
estimate: 3
assignee: jane@company.com
status: Backlog
\`\`\`

Login description.

## As a user, I want to sign up

\`\`\`yaml
priority: medium
labels: [Feature]
estimate: 2
\`\`\`

Signup description.
`;

const markdownExistingStory = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_identifier: ENG-42
plane_url: https://app.plane.so/ws/projects/${PROJECT_UUID}/issues/${PLANE_UUID}
priority: high
labels: [Feature]
\`\`\`

Updated login description.
`;

const markdownMixedStories = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_identifier: ENG-42
priority: high
labels: [Feature]
\`\`\`

Login body.

## As a user, I want to sign up

\`\`\`yaml
priority: medium
labels: [Feature]
\`\`\`

Signup body.
`;

let tmpDir: string;

function writeTmpFile(name: string, content: string): string {
	const filePath = join(tmpDir, name);
	writeFileSync(filePath, content);
	return filePath;
}

function readTmpFile(name: string): string {
	return readFileSync(join(tmpDir, name), "utf-8");
}

describe("importStories", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "importer-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	test("parses input file into UserStory[] using markdown parser", async () => {
		const filePath = writeTmpFile("stories.md", markdownNewStories);
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(summary.total).toBe(2);
		expect(summary.results[0]?.story.title).toBe("As a user, I want to log in");
		expect(summary.results[1]?.story.title).toBe("As a user, I want to sign up");
	});

	test("detects create (no plane_id) vs update (has plane_id) per story", async () => {
		const filePath = writeTmpFile("mixed.md", markdownMixedStories);
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(summary.results[0]?.action).toBe("updated");
		expect(summary.results[1]?.action).toBe("created");
	});

	test("creates new work items for stories without plane_id", async () => {
		const filePath = writeTmpFile("new.md", markdownNewStories);
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(createdItems).toHaveLength(2);
		expect(summary.created).toBe(2);
		// Results carry a project board URL for the "view in Plane" hint.
		expect(summary.results[0]?.projectUrl).toContain(`/projects/${PROJECT_UUID}/issues/`);
	});

	test("sets external_id/external_source on create for idempotency", async () => {
		const filePath = writeTmpFile("ext.md", markdownNewStories);
		const { client, createdItems } = makeFakeClient(baseData());

		await importStories(client, { files: [filePath], config: defaultConfig });

		expect(createdItems[0]!.body.external_source).toBe("planestories");
		expect(createdItems[0]!.body.external_id).toBe(makeExternalId("As a user, I want to log in"));
	});

	test("skips (as duplicate) a no-plane_id story matching an existing item — no silent hijack", async () => {
		// A no-plane_id story whose title matches an existing item (our external_id) is a
		// duplicate, NOT a silent update — so a second file can't overwrite the first's item.
		const filePath = writeTmpFile("idem.md", markdownNewStories);
		const externalId = makeExternalId("As a user, I want to log in");
		const { client, createdItems, updatedItems } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: "wi-existing",
							sequence_id: 5,
							name: "As a user, I want to log in",
							external_id: externalId,
							external_source: "planestories",
							state: { name: "Backlog" },
						},
					],
				},
			}),
		);

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		// Matching story -> skipped (duplicate); the other -> created. Nothing updated.
		expect(updatedItems).toHaveLength(0);
		expect(summary.updated).toBe(0);
		expect(summary.created).toBe(1);
		expect(summary.skipped).toBe(1);
		expect(createdItems).toHaveLength(1);
		const skipped = summary.results.find((r) => r.action === "skipped");
		expect(skipped?.note).toContain("duplicate of ENG-5");
	});

	test("--adopt-duplicates links a no-plane_id story to its existing external_id match", async () => {
		const filePath = writeTmpFile("adopt-ext.md", markdownNewStories);
		const externalId = makeExternalId("As a user, I want to log in");
		const { client, updatedItems } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: "wi-existing",
							sequence_id: 5,
							name: "As a user, I want to log in",
							external_id: externalId,
							external_source: "planestories",
							state: { name: "Backlog" },
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			adoptDuplicates: true,
		});

		expect(updatedItems.some((u) => u.workItemId === "wi-existing")).toBe(true);
		expect(summary.updated).toBe(1);
	});

	test("updates existing work items for stories with plane_id", async () => {
		const filePath = writeTmpFile("existing.md", markdownExistingStory);
		const { client, updatedItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(updatedItems).toHaveLength(1);
		expect(updatedItems[0]!.workItemId).toBe(PLANE_UUID);
		expect(summary.updated).toBe(1);
		expect(summary.results[0]?.action).toBe("updated");
	});

	test("writes back plane ids to markdown after successful creation", async () => {
		const filePath = writeTmpFile("writeback.md", markdownNewStories);
		const { client } = makeFakeClient(baseData());

		await importStories(client, { files: [filePath], config: defaultConfig });

		const updated = readTmpFile("writeback.md");
		expect(updated).toContain("plane_id: wi-101");
		expect(updated).toContain("plane_identifier: ENG-101");
		expect(updated).toContain(
			`plane_url: https://app.plane.so/ws/projects/${PROJECT_UUID}/issues/`,
		);
	});

	test("--dry-run consults the board read-only (faithful preview) but makes no writes", async () => {
		const filePath = writeTmpFile("dryrun.md", markdownNewStories);
		const originalContent = readTmpFile("dryrun.md");
		const { client, createdItems, updatedItems, calls } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		// New stories with no board match -> predicted create.
		expect(summary.results[0]?.action).toBe("skipped");
		expect(summary.results[0]?.wouldAction).toBe("create");
		expect(summary.skipped).toBe(2);
		// Reads are allowed (that's what makes the preview faithful), but NO writes.
		expect(createdItems).toHaveLength(0);
		expect(updatedItems).toHaveLength(0);
		expect(calls.some((c) => c.method === "createWorkItem" || c.method === "updateWorkItem")).toBe(
			false,
		);
		// The file is never modified in a dry run.
		expect(readTmpFile("dryrun.md")).toBe(originalContent);
	});

	test("--dry-run reports wouldAction (create vs update) per story", async () => {
		const filePath = writeTmpFile("would.md", markdownMixedStories);
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		// story 1 has a plane_id -> would update; story 2 -> would create
		expect(summary.results[0]?.wouldAction).toBe("update");
		expect(summary.results[1]?.wouldAction).toBe("create");
	});

	test("--dry-run --check resolves read-only and notes bad metadata without writing", async () => {
		// Project resolves, but the status state does not exist in the project.
		const data = baseData({ states: { [PROJECT_UUID]: [{ id: "s-todo", name: "Todo" }] } });
		const filePath = writeTmpFile("check.md", markdownNewStories);
		const { client, createdItems } = makeFakeClient(data);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			check: true,
		});

		expect(createdItems).toHaveLength(0); // still no writes
		// story 1 uses status "Backlog" which isn't in the project -> noted
		expect(summary.results[0]?.note).toContain('status "Backlog" not found');
	});

	test("does not create labels during a dry-run even with createLabels", async () => {
		const filePath = writeTmpFile("drylabels.md", markdownNewStories);
		const { client, createdLabels } = makeFakeClient({
			...baseData(),
			labels: { [PROJECT_UUID]: [] }, // no labels exist
		});

		await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			check: true,
			createLabels: true,
		});

		expect(createdLabels).toHaveLength(0);
	});

	test("--sync-criteria creates a sub-item per acceptance criterion with state from its checkbox", async () => {
		const md = `---
project: "Q1 Release"
---

## Story with criteria

\`\`\`yaml
priority: high
\`\`\`

Narrative text.

### Acceptance Criteria

- [ ] open one
- [x] done two
`;
		const file = writeTmpFile("crit.md", md);
		const { client, createdItems } = makeFakeClient(
			baseData({
				states: {
					[PROJECT_UUID]: [
						{ id: "s-backlog", name: "Backlog", group: "backlog" },
						{ id: "s-done", name: "Done", group: "completed" },
					],
				},
			}),
		);

		await importStories(client, { files: [file], config: defaultConfig, syncCriteria: true });

		// 1 parent + 2 criterion children
		expect(createdItems).toHaveLength(3);

		// Parent description has the narrative but NOT the AC checklist.
		const parent = createdItems[0]!;
		expect(String(parent.body.description_html)).toContain("Narrative text.");
		expect(String(parent.body.description_html)).not.toContain("Acceptance Criteria");

		const children = createdItems.slice(1);
		const ext = makeExternalId("Story with criteria");
		// child 0 (unchecked) -> open/backlog state; child 1 (checked) -> completed state
		expect(children[0]!.body.parent).toBe(parent ? "wi-101" : "");
		expect(children[0]!.body.external_id).toBe(`${ext}::ac0`);
		expect(children[0]!.body.state).toBe("s-backlog");
		expect(children[1]!.body.external_id).toBe(`${ext}::ac1`);
		expect(children[1]!.body.state).toBe("s-done");
	});

	test("reports created and skipped labels in the summary", async () => {
		const filePath = writeTmpFile("labelsum.md", markdownNewStories);
		// "Feature" exists; default label "Extra" does not.
		const { client } = makeFakeClient({
			...baseData(),
			labels: { [PROJECT_UUID]: [{ id: "lbl-feature", name: "Feature" }] },
		});

		const created = await importStories(client, {
			files: [filePath],
			config: { ...defaultConfig, defaultLabels: ["Extra"] },
			createLabels: true,
		});
		expect(created.labelsCreated).toContain("Extra");

		const skipped = await importStories(
			makeFakeClient({
				...baseData(),
				labels: { [PROJECT_UUID]: [{ id: "lbl-feature", name: "Feature" }] },
			}).client,
			{
				files: [writeTmpFile("labelsum2.md", markdownNewStories)],
				config: { ...defaultConfig, defaultLabels: ["Extra"] },
			},
		);
		expect(skipped.labelsSkipped).toContain("Extra");
	});

	test("--no-write-back calls API but does not write back to file", async () => {
		const filePath = writeTmpFile("nowriteback.md", markdownNewStories);
		const originalContent = readTmpFile("nowriteback.md");
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			noWriteBack: true,
		});

		expect(createdItems).toHaveLength(2);
		expect(summary.created).toBe(2);
		expect(readTmpFile("nowriteback.md")).toBe(originalContent);
	});

	test("continues on per-story failure and collects all results", async () => {
		// No project configured -> resolveProject throws for every story, but the
		// loop continues and records failures.
		const filePath = writeTmpFile("errors.md", markdownNewStories);
		const { client } = makeFakeClient({ projects: [] });

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(summary.total).toBe(2);
		expect(summary.failed).toBe(2);
		expect(summary.results[0]?.error).toBeDefined();
	});

	test("returns ImportSummary with correct counts", async () => {
		const filePath = writeTmpFile("counts.md", markdownMixedStories);
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config: defaultConfig });

		expect(summary.total).toBe(2);
		expect(summary.updated).toBe(1);
		expect(summary.created).toBe(1);
		expect(summary.failed).toBe(0);
		expect(summary.skipped).toBe(0);
	});

	test("merges story labels with config.defaultLabels", async () => {
		const filePath = writeTmpFile("labels.md", markdownNewStories);
		const { client, createdItems } = makeFakeClient(baseData());

		await importStories(client, {
			files: [filePath],
			config: { ...defaultConfig, defaultLabels: ["DefaultLabel"] },
		});

		// First story: labels [Feature] + default [DefaultLabel]
		expect(createdItems[0]!.body.labels).toEqual(["lbl-feature", "lbl-default"]);
	});

	test("sourceLabel tags every created item and auto-creates the label (no --create-labels)", async () => {
		const file = writeTmpFile("src.md", markdownNewStories);
		// "planestories" label does not exist in the project.
		const { client, createdItems, createdLabels } = makeFakeClient(
			baseData({ labels: { [PROJECT_UUID]: [{ id: "lbl-feature", name: "Feature" }] } }),
		);

		await importStories(client, {
			files: [file],
			config: defaultConfig,
			sourceLabel: "planestories",
		});

		// auto-created even though --create-labels was not passed
		expect(createdLabels.some((l) => l.name === "planestories")).toBe(true);
		// every created item carries the source label
		expect(
			createdItems.every((i) => (i.body.labels as string[]).includes("label-planestories")),
		).toBe(true);
	});

	test("config.sourceLabel applies when no flag is given; flag overrides config", async () => {
		const { client, createdItems } = makeFakeClient(
			baseData({ labels: { [PROJECT_UUID]: [{ id: "lbl-feature", name: "Feature" }] } }),
		);

		await importStories(client, {
			files: [writeTmpFile("cfg.md", markdownNewStories)],
			config: { ...defaultConfig, sourceLabel: "from-config" },
		});

		expect(createdItems[0]!.body.labels).toContain("label-from-config");
	});

	test("--project overrides frontmatter and routes all stories there", async () => {
		const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const md = `---
project: "Q1 Release"
---

## S1

body one

## S2

body two
`;
		const file = writeTmpFile("route-flag.md", md);
		const { client, createdItems } = makeFakeClient({
			projects: [
				{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" },
				{ id: OTHER, name: "Other Project", identifier: "OTH" },
			],
		});

		await importStories(client, { files: [file], config: defaultConfig, project: "Other Project" });

		expect(createdItems).toHaveLength(2);
		expect(createdItems.every((i) => i.projectId === OTHER)).toBe(true);
	});

	test("per-story project routes stories to different projects", async () => {
		const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const md = `---
project: "Q1 Release"
---

## S1

\`\`\`yaml
project: Other Project
\`\`\`

body one

## S2

body two
`;
		const file = writeTmpFile("route-perstory.md", md);
		const { client, createdItems } = makeFakeClient({
			projects: [
				{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" },
				{ id: OTHER, name: "Other Project", identifier: "OTH" },
			],
		});

		await importStories(client, { files: [file], config: defaultConfig });

		// S1 -> Other Project (per-story), S2 -> Q1 Release (frontmatter)
		expect(createdItems[0]!.projectId).toBe(OTHER);
		expect(createdItems[1]!.projectId).toBe(PROJECT_UUID);
	});

	test("fails the story when no project can be resolved anywhere", async () => {
		const filePath = writeTmpFile("noproject.md", "## A story with no project\n\nBody.\n");
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: { ...defaultConfig, defaultProject: null },
		});

		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.error).toContain("No project specified");
	});
});
