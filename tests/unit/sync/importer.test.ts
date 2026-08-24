import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownFile } from "../../../src/markdown/parser.ts";
import { importStories, makeExternalId } from "../../../src/sync/importer.ts";
import { hashStoryPayload } from "../../../src/sync/story-hash.ts";
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

	test("refuses duplicate plane_id values across files before any board write", async () => {
		const sharedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const firstFile = writeTmpFile(
			"first.md",
			`## Story One

\`\`\`yaml
plane_id: ${sharedId}
plane_identifier: ENG-1
\`\`\`

First body.
`,
		);
		const secondFile = writeTmpFile(
			"second.md",
			`## Story Two

\`\`\`yaml
plane_id: ${sharedId}
plane_identifier: ENG-2
\`\`\`

Second body.
`,
		);
		const { client, calls, createdItems, updatedItems } = makeFakeClient(baseData());

		const error = await importStories(client, {
			files: [firstFile, secondFile],
			config: defaultConfig,
			noWriteBack: true,
		}).then(
			() => null,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(sharedId);
		expect((error as Error).message).toContain("Story One");
		expect((error as Error).message).toContain("Story Two");
		expect((error as Error).message).toMatch(/edit.*plane_id/i);
		expect(createdItems).toEqual([]);
		expect(updatedItems).toEqual([]);
		expect(calls).toEqual([]);
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

	test("--dry-run --no-diff omits diff results", async () => {
		const filePath = writeTmpFile("no-diff.md", markdownExistingStory);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{ id: PLANE_UUID, sequence_id: 42, name: "Old title", state: { name: "Backlog" } },
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			diff: false,
		});

		expect(summary.results[0]?.wouldAction).toBe("update");
		expect(summary.results[0]?.diff).toBeUndefined();
		expect(summary.results[0]?.diffUnavailable).toBeUndefined();
	});

	test("--status-only dry-run diff contains only the status change", async () => {
		const markdown = `---
project: "Q1 Release"
---

## New title

\`\`\`yaml
plane_id: ${PLANE_UUID}
status: In Progress
priority: high
labels: [Feature]
estimate: 3
\`\`\`

New body.
`;
		const filePath = writeTmpFile("status-only-diff.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				states: {
					[PROJECT_UUID]: [
						{ id: "state-backlog", name: "Backlog" },
						{ id: "state-progress", name: "In Progress" },
					],
				},
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "Old title",
							description_html: "<p>Old body.</p>",
							priority: "low",
							point: 1,
							labels: [{ id: "old", name: "OldLabel" }],
							state: { name: "Backlog" },
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			statusOnly: true,
		});

		const diff = summary.results[0]?.diff;
		expect(diff?.changes.map((change) => change.field)).toEqual(["status"]);
		expect(diff?.descriptionDiffers).toBe(false);
	});

	test("status-only no-change has no fields and never claims a hash mismatch", async () => {
		const markdown = `---
project: "Q1 Release"
---

## Same

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: stale
status: Backlog
\`\`\`
`;
		const filePath = writeTmpFile("status-only-same.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{ id: PLANE_UUID, sequence_id: 42, name: "Same", state: { name: "Backlog" } },
					],
				},
			}),
		);
		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			statusOnly: true,
		});
		expect(summary.results[0]?.diff?.changes).toEqual([]);
		expect(summary.results[0]?.diff?.hashOnly).toBe(false);
	});

	test("dry-run compares assignees by member id and notes unresolved values", async () => {
		const markdown = `---
project: "Q1 Release"
---

## Same member

\`\`\`yaml
plane_id: ${PLANE_UUID}
assignee: jane
\`\`\`

Body.
`;
		const common = {
			workItems: {
				[PROJECT_UUID]: [
					{
						id: PLANE_UUID,
						sequence_id: 42,
						name: "Same member",
						description_html: "<p>Body.</p>",
						assignees: [{ id: "user-1", email: "jane@company.com", display_name: "Jane" }],
					},
				],
			},
		};
		const sameFile = writeTmpFile("assignee-same.md", markdown);
		const same = makeFakeClient(baseData(common));
		const sameSummary = await importStories(same.client, {
			files: [sameFile],
			config: defaultConfig,
			dryRun: true,
		});
		expect(sameSummary.results[0]?.diff?.changes.map((change) => change.field)).not.toContain(
			"assignee",
		);

		const missingFile = writeTmpFile(
			"assignee-missing.md",
			markdown.replace("assignee: jane", "assignee: nobody"),
		);
		const missing = makeFakeClient(baseData(common));
		const missingSummary = await importStories(missing.client, {
			files: [missingFile],
			config: defaultConfig,
			dryRun: true,
		});
		expect(missingSummary.results[0]?.diff?.changes.map((change) => change.field)).not.toContain(
			"assignee",
		);
		expect(missingSummary.results[0]?.note).toContain(
			'assignee "nobody" not found — would not be written',
		);
	});

	test("matching plane_hash process path performs no item writes and has no diff", async () => {
		const withoutHash = `---
project: "Q1 Release"
---

## Already warm

\`\`\`yaml
plane_id: ${PLANE_UUID}
priority: high
labels: [Feature]
\`\`\`

Same body.
`;
		const parsedStory = parseMarkdownFile(withoutHash, "warm.md").stories[0]!;
		const planeHash = hashStoryPayload(parsedStory, { syncCriteria: false, labels: ["Feature"] });
		const markdown = withoutHash.replace(
			`plane_id: ${PLANE_UUID}`,
			`plane_id: ${PLANE_UUID}\nplane_hash: ${planeHash}`,
		);
		const filePath = writeTmpFile("warm.md", markdown);
		const { client, calls } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		expect(summary.results[0]?.action).toBe("unchanged");
		expect(summary.results[0]?.diff).toBeUndefined();
		expect(
			calls.some((call) =>
				["createWorkItem", "updateWorkItem", "createWorkItemComment"].includes(call.method),
			),
		).toBe(false);
		// Warm unchanged stories still participate in the global relation phase so
		// asymmetric declarations can be removed; its project/index reads are allowed.
		expect(calls.some((call) => call.method === "listProjects")).toBe(true);
		expect(calls.some((call) => call.method === "listWorkItems")).toBe(true);
	});

	test("an unknown parent never claims a hash-only rewrite — apply would fail", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
parent: ENG-999
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("bad-parent.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		const result = summary.results[0]!;
		expect(result.wouldAction).toBe("update");
		expect(result.note).toContain('parent "ENG-999" not found — apply would fail');
		expect(result.diff?.changes ?? []).toEqual([]);
		// The stale hash must NOT surface as "hash mismatch only — apply would
		// rewrite and re-warm": apply fails before PATCH on the unknown parent.
		expect(result.diff?.hashOnly).toBe(false);
	});

	test("dry-run resolves the label list once per project and never for empty label sets", async () => {
		const twoChanged = `---
project: "Q1 Release"
---

## First changed story

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
labels: [Feature]
\`\`\`

New body one.

## Second changed story

\`\`\`yaml
plane_id: 22222222-2222-4222-8222-222222222222
plane_hash: "0000000000000000"
labels: [Feature]
\`\`\`

New body two.
`;
		const filePath = writeTmpFile("two-changed.md", twoChanged);
		const { client, calls } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{ id: PLANE_UUID, sequence_id: 42, name: "First changed story" },
						{
							id: "22222222-2222-4222-8222-222222222222",
							sequence_id: 43,
							name: "Second changed story",
						},
					],
				},
			}),
		);

		await importStories(client, { files: [filePath], config: defaultConfig, dryRun: true });
		const labelLists = calls.filter((call) => call.method === "listLabels").length;
		expect(labelLists).toBe(1);

		const noLabels = twoChanged.replace(/labels: \[Feature\]\n/g, "");
		const filePath2 = writeTmpFile("two-changed-nolabels.md", noLabels);
		const { client: client2, calls: calls2 } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{ id: PLANE_UUID, sequence_id: 42, name: "First changed story" },
						{
							id: "22222222-2222-4222-8222-222222222222",
							sequence_id: 43,
							name: "Second changed story",
						},
					],
				},
			}),
		);
		await importStories(client2, { files: [filePath2], config: defaultConfig, dryRun: true });
		expect(calls2.filter((call) => call.method === "listLabels").length).toBe(0);
	});

	test("parent identifier case differences are not reported as changes", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
parent: eng-7
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("parent-case.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
							parent: "33333333-3333-4333-8333-333333333333",
						},
						{
							id: "33333333-3333-4333-8333-333333333333",
							sequence_id: 7,
							name: "The epic",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		const fields = (summary.results[0]?.diff?.changes ?? []).map((change) => change.field);
		expect(fields).not.toContain("parent");
	});

	test("--dry-run --check emits a single note per unresolved field", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
status: Nope
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("dup-notes.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			check: true,
		});

		const note = summary.results[0]?.note ?? "";
		expect(note.match(/status "Nope" not found/g)?.length).toBe(1);
	});

	test("--dry-run --check emits single notes even with multiple unresolved fields", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
status: Nope
assignee: ghost@company.com
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("dup-notes-multi.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			check: true,
		});

		const note = summary.results[0]?.note ?? "";
		expect(note.match(/status "Nope" not found/g)?.length).toBe(1);
		expect(note.match(/assignee "ghost@company.com" not found/g)?.length).toBe(1);
	});

	test("a would-create story with an unknown parent never previews relation changes", async () => {
		const markdown = `---
project: "Q1 Release"
---

## Brand new story

\`\`\`yaml
parent: ENG-999
blocked_by: ENG-43
\`\`\`

New body.
`;
		const filePath = writeTmpFile("failing-create-relations.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							sequence_id: 43,
							name: "The dependency",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		const result = summary.results[0]!;
		expect(result.wouldAction).toBe("create");
		expect(result.note).toContain('parent "ENG-999" not found — apply would fail');
		expect(summary.relationChanges).toEqual([]);
		expect(summary.relationsCreated).toBe(0);
	});

	test("an index-missing update with an unknown parent never previews relation changes", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: 55555555-5555-4555-8555-555555555555
plane_hash: "0000000000000000"
parent: ENG-999
blocked_by: ENG-43
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("failing-missing-index.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							sequence_id: 43,
							name: "The dependency",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		const result = summary.results[0]!;
		expect(result.wouldAction).toBe("update");
		expect(result.note).toContain('parent "ENG-999" not found — apply would fail');
		expect(summary.relationChanges).toEqual([]);
	});

	test("duplicate-guard targets never claim apply-would-fail on an unknown parent", async () => {
		const markdown = `---
project: "Q1 Release"
---

## The dependency

\`\`\`yaml
parent: ENG-999
\`\`\`

Duplicate title body.
`;
		const filePath = writeTmpFile("dup-parent.md", markdown);
		const dupItems = [
			{ id: "44444444-4444-4444-8444-444444444444", sequence_id: 43, name: "The dependency" },
		];
		const { client } = makeFakeClient(baseData({ workItems: { [PROJECT_UUID]: dupItems } }));
		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});
		const skip = summary.results[0]!;
		// Apply exits at the duplicate guard BEFORE parent validation — the skip
		// preview must not carry a contradictory apply-would-fail verdict.
		expect(skip.note ?? "").not.toContain("apply would fail");
		expect(skip.applyWouldFail).toBeUndefined();

		const multiItems = [
			...dupItems,
			{ id: "66666666-6666-4666-8666-666666666666", sequence_id: 44, name: "The dependency" },
		];
		const { client: client2 } = makeFakeClient(
			baseData({ workItems: { [PROJECT_UUID]: multiItems } }),
		);
		const summary2 = await importStories(client2, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			adoptDuplicates: true,
		});
		const multi = summary2.results[0]!;
		expect(multi.note ?? "").not.toContain("apply would fail");
		expect(multi.applyWouldFail).toBeUndefined();
	});

	test("check notes containing the join delimiter never duplicate", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
status: "Ready; QA"
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("delimiter-note.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
			check: true,
		});

		const note = summary.results[0]?.note ?? "";
		expect(note.match(/status "Ready; QA" not found/g)?.length).toBe(1);
	});

	test("a story apply would fail on never previews relation changes", async () => {
		const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: "0000000000000000"
parent: ENG-999
blocked_by: ENG-43
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("failing-relations.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "As a user, I want to log in",
							description_html: "<p>Same body.</p>",
						},
						{
							id: "44444444-4444-4444-8444-444444444444",
							sequence_id: 43,
							name: "The dependency",
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		const result = summary.results[0]!;
		expect(result.note).toContain('parent "ENG-999" not found — apply would fail');
		// Apply fails before PATCH and before relation enrollment — the dry-run
		// preview must not promise relation work that apply will never perform.
		expect(summary.relationChanges).toEqual([]);
		expect(summary.relationsCreated).toBe(0);
	});

	test("dry-run update missing from the board index marks the diff unavailable", async () => {
		const filePath = writeTmpFile("missing-index.md", markdownExistingStory);
		const { client } = makeFakeClient(baseData());

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		expect(summary.results[0]?.wouldAction).toBe("update");
		expect(summary.results[0]?.diff).toBeUndefined();
		expect(summary.results[0]?.diffUnavailable).toBe("item not in index");
	});

	test("dry-run update exposes the hash-only rendering result when board fields match", async () => {
		const markdown = `---
project: "Q1 Release"
---

## Same title

\`\`\`yaml
plane_id: ${PLANE_UUID}
plane_hash: stale-hash
priority: high
labels: [Feature]
estimate: 3
status: Backlog
\`\`\`

Same body.
`;
		const filePath = writeTmpFile("hash-only.md", markdown);
		const { client } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{
							id: PLANE_UUID,
							sequence_id: 42,
							name: "Same title",
							description_html: "<p>Same body.</p>",
							priority: "high",
							point: 3,
							labels: [{ id: "lbl-feature", name: "Feature" }],
							state: { name: "Backlog" },
						},
					],
				},
			}),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config: defaultConfig,
			dryRun: true,
		});

		expect(summary.results[0]?.diff).toMatchObject({
			changes: [],
			descriptionDiffers: false,
			hashOnly: true,
		});
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

	test("removes an asymmetric dependency when changed A and warm unchanged B are re-imported", async () => {
		const aId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const bId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const withoutHash = `---
project: "Q1 Release"
---

## A

\`\`\`yaml
plane_id: ${aId}
plane_identifier: ENG-1
plane_hash: stale
\`\`\`

A no longer declares a blocker.

## B

\`\`\`yaml
plane_id: ${bId}
plane_identifier: ENG-2
\`\`\`

B body.
`;
		const bStory = parseMarkdownFile(withoutHash, "relations.md").stories[1]!;
		const bHash = hashStoryPayload(bStory, { syncCriteria: false, labels: [] });
		const markdown = withoutHash.replace(
			`plane_identifier: ENG-2`,
			`plane_identifier: ENG-2\nplane_hash: ${bHash}`,
		);
		const board = {
			workItems: {
				[PROJECT_UUID]: [
					{
						id: aId,
						sequence_id: 1,
						name: "A",
						description_html: "<p>Old A body.</p>",
						external_source: "planestories",
					},
					{
						id: bId,
						sequence_id: 2,
						name: "B",
						description_html: "<p>B body.</p>",
						external_source: "planestories",
					},
				],
			},
			relations: { [aId]: { blocked_by: [bId] } },
		};

		const dryFile = writeTmpFile("relations-dry.md", markdown);
		const dry = makeFakeClient(baseData(board));
		const preview = await importStories(dry.client, {
			files: [dryFile],
			config: defaultConfig,
			dryRun: true,
		});
		expect(preview.relationsRemoved).toBe(1);
		expect(preview.relationChanges[0]?.removed).toEqual(["blocked_by ENG-2"]);

		const applyFile = writeTmpFile("relations-apply.md", markdown);
		const apply = makeFakeClient(baseData(board));
		const result = await importStories(apply.client, {
			files: [applyFile],
			config: defaultConfig,
			noWriteBack: true,
		});
		expect(result.relationsRemoved).toBe(1);
		expect(apply.removedRelations).toEqual([
			{ projectId: PROJECT_UUID, workItemId: aId, relationType: "blocked_by", relatedIssue: bId },
		]);
	});
});
