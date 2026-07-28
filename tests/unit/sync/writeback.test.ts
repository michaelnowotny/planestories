import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCheckboxStates, reverseSyncCriteria } from "../../../src/sync/writeback.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

/** Build a desired-state map: plane_id -> (criterion position -> checked). */
function states(
	entries: Record<string, Record<number, boolean>>,
): Map<string, Map<number, boolean>> {
	const out = new Map<string, Map<number, boolean>>();
	for (const [planeId, byPos] of Object.entries(entries)) {
		const inner = new Map<number, boolean>();
		for (const [pos, checked] of Object.entries(byPos)) {
			inner.set(Number(pos), checked);
		}
		out.set(planeId, inner);
	}
	return out;
}

/** An H2 story section carrying a yaml `plane_id` block, ready to join with "\n". */
function linked(planeId: string, title: string, ...body: string[]): string[] {
	return ["## " + title, "", "```yaml", "plane_id: " + planeId, "```", "", ...body];
}

describe("applyCheckboxStates (pure, plane_id-keyed reverse-sync)", () => {
	test("ticks a box the board reports completed, preserving text and indentation", () => {
		const content = [
			...linked(
				"p1",
				"Log in",
				"Narrative here.",
				"",
				"### Acceptance Criteria",
				"",
				"- [ ] enters email",
				"- [ ] enters password",
			),
			"",
		].join("\n");

		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ p1: { 0: true, 1: false } }),
		);

		expect(out).toContain("- [x] enters email");
		expect(out).toContain("- [ ] enters password");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ title: "Log in", position: 0, from: false, to: true });
		expect(changes[0]?.text).toBe("enters email");
	});

	test("unticks a box the board reports not-completed", () => {
		const content = linked("p1", "S", "### Acceptance Criteria", "- [x] done thing", "").join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ p1: { 0: false } }));
		expect(out).toContain("- [ ] done thing");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ position: 0, from: true, to: false });
	});

	test("is idempotent — no change when file already matches the board", () => {
		const content = linked("p1", "S", "### Acceptance Criteria", "- [x] a", "- [ ] b", "").join(
			"\n",
		);
		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ p1: { 0: true, 1: false } }),
		);
		expect(out).toBe(content);
		expect(changes).toHaveLength(0);
	});

	test("only rewrites checkboxes inside the AC section, never the narrative", () => {
		const content = linked(
			"p1",
			"S",
			"- [ ] a narrative todo (not a criterion)",
			"",
			"### Acceptance Criteria",
			"- [ ] real criterion",
			"",
		).join("\n");
		const { content: out } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [ ] a narrative todo (not a criterion)"); // untouched
		expect(out).toContain("- [x] real criterion");
	});

	test("preserves criterion text exactly (does NOT rebuild from board names)", () => {
		const content = linked(
			"p1",
			"S",
			"### Acceptance Criteria",
			"- [ ] `foo.stories.md` passes **planestories** validation",
			"",
		).join("\n");
		const { content: out } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [x] `foo.stories.md` passes **planestories** validation");
	});

	test("a gap in the desired map (missing ::acN index) leaves that box untouched", () => {
		const content = linked(
			"p1",
			"S",
			"### Acceptance Criteria",
			"- [ ] a",
			"- [ ] b",
			"- [ ] c",
			"",
		).join("\n");
		// Only positions 0 and 2 known (criterion 1 was removed on the board).
		const { content: out, changes } = applyCheckboxStates(
			content,
			states({ p1: { 0: true, 2: true } }),
		);
		expect(out).toContain("- [x] a");
		expect(out).toContain("- [ ] b"); // untouched
		expect(out).toContain("- [x] c");
		expect(changes).toHaveLength(2);
	});

	test("keys by plane_id across multiple stories", () => {
		const content = [
			...linked("p1", "First", "### Acceptance Criteria", "- [ ] one"),
			"",
			...linked("p2", "Second", "### Acceptance Criteria", "- [ ] two"),
			"",
		].join("\n");
		const { content: out } = applyCheckboxStates(
			content,
			states({ p1: { 0: true }, p2: { 0: false } }),
		);
		expect(out).toContain("- [x] one");
		expect(out).toContain("- [ ] two");
	});

	test("recognizes a Setext acceptance-criteria heading", () => {
		const content = linked(
			"p1",
			"S",
			"Acceptance Criteria",
			"===================",
			"- [ ] setext criterion",
			"",
		).join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [x] setext criterion");
		expect(changes).toHaveLength(1);
	});

	test("ignores an acceptance-criteria heading BEFORE the yaml block (body starts after yaml)", () => {
		// A decoy AC + box before the ```yaml``` block must NOT be counted — the parser
		// takes the body AFTER the yaml block, so ::ac0 is the post-yaml "real" criterion.
		const content = [
			"## S",
			"",
			"### Acceptance Criteria",
			"- [ ] decoy before yaml",
			"",
			"```yaml",
			"plane_id: p1",
			"```",
			"",
			"### Acceptance Criteria",
			"- [ ] real",
			"",
		].join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [ ] decoy before yaml"); // untouched
		expect(out).toContain("- [x] real");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.text).toBe("real");
	});

	test("duplicate H2 titles do NOT cross-contaminate — only the plane_id-matched story changes", () => {
		// One "## S" is linked (plane_id p1); an identical "## S" is UNLINKED (no yaml).
		// The unlinked twin must be left alone.
		const content = [
			...linked("p1", "S", "### Acceptance Criteria", "- [ ] linked one"),
			"",
			"## S",
			"",
			"### Acceptance Criteria",
			"- [ ] unlinked twin",
			"",
		].join("\n");
		const { content: out, changes } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [x] linked one");
		expect(out).toContain("- [ ] unlinked twin"); // the twin (no plane_id) is untouched
		expect(changes).toHaveLength(1);
	});

	test("a leading frontmatter block does not shift matching (plane_id keying is offset-free)", () => {
		const content = [
			"---",
			"project: Data Platform",
			"---",
			"",
			...linked("p1", "Only story", "### Acceptance Criteria", "- [ ] real"),
			"",
		].join("\n");
		const { content: out } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toContain("- [x] real");
	});

	test("a story with no yaml plane_id is never matched", () => {
		const content = ["## Bare", "", "### Acceptance Criteria", "- [ ] nope", ""].join("\n");
		// Even if the caller (wrongly) had a state for some id, a yaml-less section is skipped.
		const { content: out, changes } = applyCheckboxStates(content, states({ p1: { 0: true } }));
		expect(out).toBe(content);
		expect(changes).toHaveLength(0);
	});

	test("stops counting criteria at the next heading after AC", () => {
		const content = linked(
			"p1",
			"S",
			"### Acceptance Criteria",
			"- [ ] real",
			"",
			"### Notes",
			"- [ ] not a criterion",
			"",
		).join("\n");
		// Position 1 would be the Notes checkbox; it must NOT be affected.
		const { content: out } = applyCheckboxStates(content, states({ p1: { 0: true, 1: true } }));
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

	test("fails closed on duplicate ::acN — box unchanged + a warning (stale renamed criteria)", async () => {
		// A title rename can leave `<old-slug>::ac0` alongside a fresh `<new-slug>::ac0`
		// under the same parent — both map to position 0. The box must be left as-is.
		const board: FakeData = {
			projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
			workItems: {
				[PROJECT_UUID]: [
					{
						id: "wi-parent",
						sequence_id: 12,
						name: "Build thing",
						external_source: "planestories",
						external_id: "new-slug",
						state: { id: "s", name: "In Progress", group: "started" },
					},
					{
						id: "wi-old",
						sequence_id: 13,
						name: "stale",
						parent: "wi-parent",
						external_source: "planestories",
						external_id: "old-slug::ac0",
						state: { id: "s2", name: "Done", group: "completed" },
					},
					{
						id: "wi-new",
						sequence_id: 14,
						name: "fresh",
						parent: "wi-parent",
						external_source: "planestories",
						external_id: "new-slug::ac0",
						state: { id: "s3", name: "Backlog", group: "backlog" },
					},
				],
			},
		};
		const filePath = join(tmpDir, "s.stories.md");
		const content = [
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
			"### Acceptance Criteria",
			"- [ ] the one criterion",
			"",
		].join("\n");
		writeFileSync(filePath, content);
		const { client } = makeFakeClient(board);

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: true });

		expect(report.totalChanges).toBe(0);
		expect(report.files[0]?.warnings.join(" ")).toContain("::ac0");
		expect(readFileSync(filePath, "utf8")).toContain("- [ ] the one criterion"); // unchanged
	});

	test("a blank plane_id counts as unlinked, not a stale link", async () => {
		const filePath = join(tmpDir, "s.stories.md");
		const content = storyFile().replace("plane_id: wi-parent", 'plane_id: "   "');
		writeFileSync(filePath, content);
		const { client } = makeFakeClient(boardData());

		const report = await reverseSyncCriteria(client, { config, files: [filePath], apply: true });

		expect(report.files[0]?.linkedStories).toBe(0);
		expect(report.files[0]?.unlinkedStories).toBe(1);
		expect(report.files[0]?.missingOnBoard).toHaveLength(0);
	});

	test("a mid-batch error leaves NO partial writes (two-pass)", async () => {
		const good = join(tmpDir, "a.stories.md");
		const goodBefore = storyFile(); // frontmatter project: Data Platform, needs a tick
		writeFileSync(good, goodBefore);
		// Second file: a linked story with NO project and NO default -> throws in pass 1.
		const bad = join(tmpDir, "b.stories.md");
		writeFileSync(
			bad,
			[
				"## Orphan",
				"",
				"```yaml",
				"plane_id: wi-parent",
				"```",
				"",
				"### Acceptance Criteria",
				"- [ ] x",
				"",
			].join("\n"),
		);
		const noDefault: ResolvedConfig = { ...config, defaultProject: null };
		const { client } = makeFakeClient(boardData());

		await expect(
			reverseSyncCriteria(client, { config: noDefault, files: [good, bad], apply: true }),
		).rejects.toBeTruthy();
		// The good file must be untouched despite having pending changes.
		expect(readFileSync(good, "utf8")).toBe(goodBefore);
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
