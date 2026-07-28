import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCheckboxStates, reverseSyncCriteria } from "../../../src/sync/writeback.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

/** Build a desired-state map: title -> (position -> checked). */
function states(
	entries: Record<string, Record<number, boolean>>,
): Map<string, Map<number, boolean>> {
	const out = new Map<string, Map<number, boolean>>();
	for (const [title, byPos] of Object.entries(entries)) {
		const inner = new Map<number, boolean>();
		for (const [pos, checked] of Object.entries(byPos)) {
			inner.set(Number(pos), checked);
		}
		out.set(title, inner);
	}
	return out;
}

describe("applyCheckboxStates (pure in-place reverse-sync)", () => {
	test("ticks a box the board reports completed, preserving text and indentation", () => {
		const content = [
			"## Log in",
			"",
			"Narrative here.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] enters email",
			"- [ ] enters password",
			"",
		].join("\n");

		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ "Log in": { 0: true, 1: false } }),
		);

		expect(out).toContain("- [x] enters email");
		expect(out).toContain("- [ ] enters password");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ title: "Log in", position: 0, from: false, to: true });
		expect(changes[0]?.text).toBe("enters email");
	});

	test("unticks a box the board reports not-completed", () => {
		const content = ["## S", "", "### Acceptance Criteria", "- [x] done thing", ""].join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ S: { 0: false } }));
		expect(out).toContain("- [ ] done thing");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ position: 0, from: true, to: false });
	});

	test("is idempotent — no change when file already matches the board", () => {
		const content = ["## S", "", "### Acceptance Criteria", "- [x] a", "- [ ] b", ""].join("\n");
		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ S: { 0: true, 1: false } }),
		);
		expect(out).toBe(content);
		expect(changes).toHaveLength(0);
	});

	test("only rewrites checkboxes inside the AC section, never the narrative", () => {
		const content = [
			"## S",
			"",
			"- [ ] a narrative todo (not a criterion)",
			"",
			"### Acceptance Criteria",
			"- [ ] real criterion",
			"",
		].join("\n");
		const { content: out } = applyCheckboxStates(content, states({ S: { 0: true } }));
		expect(out).toContain("- [ ] a narrative todo (not a criterion)"); // untouched
		expect(out).toContain("- [x] real criterion");
	});

	test("preserves criterion text exactly (does NOT rebuild from board names)", () => {
		const content = [
			"## S",
			"",
			"### Acceptance Criteria",
			"- [ ] `foo.stories.md` passes **planestories** validation",
			"",
		].join("\n");
		const { content: out } = applyCheckboxStates(content, states({ S: { 0: true } }));
		expect(out).toContain("- [x] `foo.stories.md` passes **planestories** validation");
	});

	test("a gap in the desired map (missing ::acN index) leaves that box untouched", () => {
		const content = [
			"## S",
			"",
			"### Acceptance Criteria",
			"- [ ] a",
			"- [ ] b",
			"- [ ] c",
			"",
		].join("\n");
		// Only positions 0 and 2 known (criterion 1 was removed on the board).
		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ S: { 0: true, 2: true } }),
		);
		expect(out).toContain("- [x] a");
		expect(out).toContain("- [ ] b"); // untouched
		expect(out).toContain("- [x] c");
		expect(changes).toHaveLength(2);
	});

	test("keys by H2 title across multiple stories", () => {
		const content = [
			"## First",
			"",
			"### Acceptance Criteria",
			"- [ ] one",
			"",
			"## Second",
			"",
			"### Acceptance Criteria",
			"- [ ] two",
			"",
		].join("\n");
		const { content: out } = applyCheckboxStates(
			content,
			states({ First: { 0: true }, Second: { 0: false } }),
		);
		expect(out).toContain("- [x] one");
		expect(out).toContain("- [ ] two");
	});

	test("recognizes a Setext acceptance-criteria heading", () => {
		const content = [
			"## S",
			"",
			"Acceptance Criteria",
			"===================",
			"- [ ] setext criterion",
			"",
		].join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ S: { 0: true } }));
		expect(out).toContain("- [x] setext criterion");
		expect(changes).toHaveLength(1);
	});

	test("stops counting criteria at the next heading after AC", () => {
		const content = [
			"## S",
			"",
			"### Acceptance Criteria",
			"- [ ] real",
			"",
			"### Notes",
			"- [ ] not a criterion",
			"",
		].join("\n");
		// Position 1 would be the Notes checkbox; it must NOT be affected.
		const { content: out } = applyCheckboxStates(content, states({ S: { 0: true, 1: true } }));
		expect(out).toContain("- [x] real");
		expect(out).toContain("- [ ] not a criterion");
	});
});

const PROJECT_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Data Platform",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

/** A parent story with two criterion children: ac0 completed, ac1 backlog. */
function boardData(): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
		workItems: {
			[PROJECT_UUID]: [
				{
					id: "wi-parent",
					sequence_id: 12,
					name: "Build thing",
					external_source: "planestories",
					external_id: "build-thing",
					state: { id: "s1", name: "In Progress", group: "started" },
				},
				{
					id: "wi-c0",
					sequence_id: 13,
					name: "first criterion",
					parent: "wi-parent",
					external_source: "planestories",
					external_id: "build-thing::ac0",
					state: { id: "s2", name: "Done", group: "completed" },
				},
				{
					id: "wi-c1",
					sequence_id: 14,
					name: "second criterion",
					parent: "wi-parent",
					external_source: "planestories",
					external_id: "build-thing::ac1",
					state: { id: "s3", name: "Backlog", group: "backlog" },
				},
			],
		},
	};
}

function storyFile(): string {
	return [
		"---",
		"project: Data Platform",
		"---",
		"",
		"## Build thing",
		"",
		"```yaml",
		"plane_id: wi-parent",
		"plane_identifier: DATA-12",
		"```",
		"",
		"Narrative.",
		"",
		"### Acceptance Criteria",
		"",
		"- [ ] first criterion",
		"- [ ] second criterion",
		"",
	].join("\n");
}

describe("reverseSyncCriteria (board→file wrapper)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "writeback-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("dry-run reports the box that would flip WITHOUT writing the file", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		const before = storyFile();
		writeFileSync(filePath, before);
		const { client } = makeFakeClient(boardData());

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: false });

		expect(report.applied).toBe(false);
		expect(report.totalChanges).toBe(1);
		expect(report.files[0]?.changes[0]).toMatchObject({ position: 0, from: false, to: true });
		expect(report.files[0]?.written).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(before); // untouched
	});

	test("apply writes only the completed box, preserving the other", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		writeFileSync(filePath, storyFile());
		const { client } = makeFakeClient(boardData());

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: true });

		expect(report.totalChanges).toBe(1);
		expect(report.files[0]?.written).toBe(true);
		const after = readFileSync(filePath, "utf8");
		expect(after).toContain("- [x] first criterion");
		expect(after).toContain("- [ ] second criterion");
	});

	test("re-running after apply is a no-op (idempotent)", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		writeFileSync(filePath, storyFile());
		const { client } = makeFakeClient(boardData());

		await reverseSyncCriteria(client, { config, files: [filePath], apply: true });
		const second = await reverseSyncCriteria(client, { config, files: [filePath], apply: true });

		expect(second.totalChanges).toBe(0);
		expect(second.files[0]?.written).toBe(false);
	});

	test("a linked story missing on the board is flagged, not crashed", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		const content = storyFile().replace("plane_id: wi-parent", "plane_id: wi-ghost");
		writeFileSync(filePath, content);
		const { client } = makeFakeClient(boardData());

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: false });

		expect(report.totalChanges).toBe(0);
		expect(report.files[0]?.missingOnBoard).toContain("DATA-12");
	});

	test("an unlinked story (no plane_id) is skipped and counted", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		const content = [
			"---",
			"project: Data Platform",
			"---",
			"",
			"## Fresh story",
			"",
			"### Acceptance Criteria",
			"- [ ] not linked yet",
			"",
		].join("\n");
		writeFileSync(filePath, content);
		const { client } = makeFakeClient(boardData());

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: true });

		expect(report.files[0]?.linkedStories).toBe(0);
		expect(report.files[0]?.unlinkedStories).toBe(1);
		expect(report.totalChanges).toBe(0);
	});
});
