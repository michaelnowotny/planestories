import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig } from "../../../src/config/repo_config.ts";
import { lintFiles } from "../../../src/lint/linter.ts";
import { ALL_LINT_RULES, type LintRule, runLintRules } from "../../../src/lint/rules.ts";
import type { UserStory } from "../../../src/types.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-lint-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeMarkdown(name: string, content: string): string {
	const filePath = join(directory, name);
	writeFileSync(filePath, content);
	return filePath;
}

function story(title: string, metadata: string[], body: string): string {
	return [`## ${title}`, "", "```yaml", ...metadata, "```", "", body.trim(), ""].join("\n");
}

const CRITERIA = ["### Acceptance Criteria", "", "- [ ] It works"].join("\n");
const EFFORT = "**Effort:** 1 dev-day";
const WHY = ["# wHy Is ThIs NeEdEd?", "", "Because this outcome matters."].join("\n");

function rules(report: Awaited<ReturnType<typeof lintFiles>>): LintRule[] {
	return report.findings.map((finding) => finding.rule);
}

describe("disabledRules (from .planestories.yml lint.disable)", () => {
	test("a disabled rule produces no finding", async () => {
		const file = writeMarkdown(
			"missing-effort.md",
			story("Needs effort", ["plane_identifier: APP-1"], `${CRITERIA}`),
		);
		// Without disabling, missing-effort fires.
		expect(rules(await lintFiles([file]))).toContain("missing-effort");
		// Disabled -> no finding, clean exit.
		const report = await lintFiles([file], { disabledRules: ["missing-effort"] });
		expect(rules(report)).not.toContain("missing-effort");
		expect(report.exitCode).toBe(0);
	});
});

describe("lint rules", () => {
	test("missing-acceptance-criteria", async () => {
		const file = writeMarkdown(
			"missing-ac.md",
			story("Needs criteria", ["plane_identifier: APP-1"], `${EFFORT}\n\nDescription.`),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["missing-acceptance-criteria"]);
		expect(report.errors).toBe(1);
		expect(report.exitCode).toBe(1);
	});

	test("missing-effort", async () => {
		const file = writeMarkdown(
			"missing-effort.md",
			story("Needs effort", ["plane_identifier: APP-1"], `Description.\n\n${CRITERIA}`),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["missing-effort"]);
	});

	test("epic-missing-why", async () => {
		const file = writeMarkdown(
			"epic-no-why.md",
			story("Epic without rationale", ["kind: epic", "plane_identifier: APP-1"], "Scope."),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["epic-missing-why"]);
	});

	test("epic-missing-why ignores headings inside fenced code", async () => {
		const file = writeMarkdown(
			"epic-fenced-why.md",
			story(
				"Epic with example heading only",
				["kind: epic", "plane_identifier: APP-1"],
				["Scope.", "", "```markdown", "### Why is this needed?", "```"].join("\n"),
			),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["epic-missing-why"]);
	});

	test("epic-has-acceptance-criteria", async () => {
		const file = writeMarkdown(
			"epic-with-ac.md",
			story(
				"Epic with criteria",
				["kind: epic", "plane_identifier: APP-1"],
				`${WHY}\n\n${CRITERIA}`,
			),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["epic-has-acceptance-criteria"]);
	});

	test("dependency-self-reference reads the parser's retained raw validation", async () => {
		const file = writeMarkdown(
			"self-reference.md",
			story(
				"Self reference",
				["plane_identifier: APP-1", "blocked_by: [APP-1]"],
				`**Blocks:** APP-1\n\n${EFFORT}\n\n${CRITERIA}`,
			),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["dependency-self-reference"]);
		expect(report.findings[0]?.message).toContain("blocked_by");
		expect(report.findings[0]?.message).toContain("blocks");
	});

	test("dependency-cycle", async () => {
		const file = writeMarkdown(
			"cycle.md",
			[
				story("First", ["plane_identifier: APP-1", "blocks: [APP-2]"], `${EFFORT}\n\n${CRITERIA}`),
				story("Second", ["plane_identifier: APP-2", "blocks: [APP-1]"], `${EFFORT}\n\n${CRITERIA}`),
			].join("\n"),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["dependency-cycle", "dependency-cycle"]);
	});

	test("duplicate-identifier reports every declaration", async () => {
		const file = writeMarkdown(
			"duplicates.md",
			[
				story("First", ["plane_identifier: APP-1"], `${EFFORT}\n\n${CRITERIA}`),
				story("Second", ["plane_identifier: APP-1"], `${EFFORT}\n\n${CRITERIA}`),
			].join("\n"),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["duplicate-identifier", "duplicate-identifier"]);
		expect(report.findings.map((finding) => finding.story?.title)).toEqual(["First", "Second"]);
	});

	test("dangling-reference is warning-only under strict defaults", async () => {
		const file = writeMarkdown(
			"dangling.md",
			story(
				"Dangling dependency",
				["plane_identifier: APP-1", "blocked_by: [BOARD-99]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["dangling-reference"]);
		expect(report.errors).toBe(0);
		expect(report.warnings).toBe(1);
		expect(report.exitCode).toBe(0);
	});

	test("orphan-criterion", async () => {
		const file = writeMarkdown(
			"orphan.md",
			story("Detached criterion", ["kind: criterion", "plane_identifier: APP-2"], "Detail."),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["orphan-criterion"]);
	});

	test("bad-parent", async () => {
		const file = writeMarkdown(
			"bad-parent.md",
			[
				story("Regular parent story", ["plane_identifier: APP-1"], `${EFFORT}\n\n${CRITERIA}`),
				story(
					"Child of regular story",
					["plane_identifier: APP-2", "parent: APP-1"],
					`${EFFORT}\n\n${CRITERIA}`,
				),
			].join("\n"),
		);

		const report = await lintFiles([file]);

		expect(rules(report)).toEqual(["bad-parent"]);
	});
});

describe("lint filesets and modes", () => {
	test("a fully valid fileset has no findings and exits zero", async () => {
		const file = writeMarkdown(
			"valid.md",
			[
				story("Release outcome", ["plane_identifier: APP-1"], WHY),
				story(
					"Deliver the outcome",
					["plane_identifier: APP-2", "parent: APP-1"],
					`${EFFORT}\n\n${CRITERIA}`,
				),
			].join("\n"),
		);

		const report = await lintFiles([file]);

		expect(report.findings).toEqual([]);
		expect(report.errors).toBe(0);
		expect(report.warnings).toBe(0);
		expect(report.exitCode).toBe(0);
	});

	test("--warn-only downgrades hard violations and exits zero", async () => {
		const file = writeMarkdown(
			"warn-only.md",
			story("Needs effort", ["plane_identifier: APP-1"], CRITERIA),
		);

		const report = await lintFiles([file], { warnOnly: true });

		expect(rules(report)).toEqual(["missing-effort"]);
		expect(report.errors).toBe(0);
		expect(report.warnings).toBe(1);
		expect(report.findings[0]?.severity).toBe("warning");
		expect(report.exitCode).toBe(0);
	});

	test("a criterion child satisfies acceptance criteria", async () => {
		const file = writeMarkdown(
			"criterion-child.md",
			[
				story("Parent story", ["plane_identifier: APP-1"], `${EFFORT}\n\nDescription.`),
				story(
					"Expected behavior",
					["kind: criterion", "plane_identifier: APP-2", "parent: APP-1"],
					"Detail.",
				),
			].join("\n"),
		);

		const report = await lintFiles([file]);

		expect(report.findings).toEqual([]);
	});

	test("cross-file parent and dependency references resolve", async () => {
		const epic = writeMarkdown(
			"epic.md",
			story("Shared epic", ["kind: epic", "plane_identifier: APP-1"], WHY),
		);
		// The blocker is a SIBLING, not the parent. This fixture used to declare
		// `blocked_by: [APP-1]` alongside `parent: APP-1` — which is the nested
		// dependency the graph commands now refuse to project, so the test would
		// have been defending a state the tool rejects. The intent here is
		// cross-FILE resolution; the nesting was incidental to it.
		const sibling = writeMarkdown(
			"sibling.md",
			story("Cross-file sibling", ["plane_identifier: APP-3"], `${EFFORT}\n\n${CRITERIA}`),
		);
		const child = writeMarkdown(
			"child.md",
			story(
				"Cross-file child",
				["plane_identifier: APP-2", "parent: APP-1", "blocked_by: [APP-3]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);

		const report = await lintFiles([child, epic, sibling]);

		expect(report.findings).toEqual([]);
	});

	test("parent resolution is exact while dependency resolution is normalized", async () => {
		const parent = writeMarkdown(
			"parent.md",
			story("Raw identifier", ["plane_identifier: app-1"], `${EFFORT}\n\n${CRITERIA}`),
		);
		const references = writeMarkdown(
			"references.md",
			[
				story(
					"Case-mismatched parent",
					["plane_identifier: APP-2", "parent: APP-1"],
					`${EFFORT}\n\n${CRITERIA}`,
				),
				story(
					"Case-matched dependency",
					["plane_identifier: APP-3", "blocked_by: [APP-1]"],
					`${EFFORT}\n\n${CRITERIA}`,
				),
			].join("\n"),
		);

		const report = await lintFiles([parent, references]);

		expect(rules(report)).toEqual(["dangling-reference"]);
		expect(report.findings[0]?.story?.title).toBe("Case-mismatched parent");
		expect(report.findings[0]?.message).toContain("parent references APP-1");
	});

	test("a dependency cycle spanning two files is caught", async () => {
		const first = writeMarkdown(
			"first.md",
			story("First", ["plane_identifier: APP-1", "blocks: [APP-2]"], `${EFFORT}\n\n${CRITERIA}`),
		);
		const second = writeMarkdown(
			"second.md",
			story("Second", ["plane_identifier: APP-2", "blocks: [APP-1]"], `${EFFORT}\n\n${CRITERIA}`),
		);

		const report = await lintFiles([first, second]);

		expect(rules(report)).toEqual(["dependency-cycle", "dependency-cycle"]);
		expect(report.findings.map((finding) => finding.filePath)).toEqual([first, second]);
	});

	test("a cross-file dangling reference warns without failing", async () => {
		const first = writeMarkdown(
			"first.md",
			story(
				"External relation",
				["plane_identifier: APP-1", "relates_to: [BOARD-99]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);
		const second = writeMarkdown(
			"second.md",
			story("Independent", ["plane_identifier: APP-2"], `${EFFORT}\n\n${CRITERIA}`),
		);

		const report = await lintFiles([first, second]);

		expect(rules(report)).toEqual(["dangling-reference"]);
		expect(report.errors).toBe(0);
		expect(report.warnings).toBe(1);
		expect(report.exitCode).toBe(0);
	});

	test("a large acyclic dependency chain does not overflow the call stack", () => {
		const count = 20_000;
		const stories = Array.from({ length: count }, (_, index) => {
			const identifier = `APP-${index + 1}`;
			const story: UserStory = {
				title: identifier,
				planeId: null,
				planeIdentifier: identifier,
				planeUrl: null,
				planeHash: null,
				priority: null,
				labels: [],
				estimate: null,
				effortDays: 1,
				assignee: null,
				status: null,
				body: CRITERIA,
				project: null,
				parent: null,
				blockedBy: [],
				blocks: index + 1 < count ? [`APP-${index + 2}`] : [],
				relatesTo: [],
				kind: "story",
				comment: null,
			};
			return { filePath: "chain.md", story };
		});

		expect(runLintRules(stories)).toEqual([]);
	});
});

/**
 * A file that will not parse is a FINDING, not a crash.
 *
 * `lint` is the offline structural checker and a CI gate. A raw ParseError gave
 * a bare message with no file attached, and stopped at the first bad file — so a
 * run over twenty files reported one of them and exited zero.
 */
describe("unparseable files", () => {
	const nested = [
		"---",
		'project: "P"',
		"---",
		"",
		"## As a user, I want a thing, so that I benefit",
		"",
		"Body text long enough to be meaningful.",
		"",
		"### Acceptance Criteria",
		"- [ ] parent",
		"  - [ ] child",
		"",
	].join("\n");

	test("reports the file instead of throwing, and keeps linting the others", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lint-unparseable-"));
		try {
			const bad = join(dir, "bad.md");
			const good = join(dir, "good.md");
			writeFileSync(bad, nested);
			writeFileSync(
				good,
				["---", 'project: "P"', "---", "", "## Just a heading", "", "x"].join("\n"),
			);

			const report = await lintFiles([bad, good]);

			const unparseable = report.findings.filter((f) => f.rule === "unparseable-file");
			expect(unparseable).toHaveLength(1);
			expect(unparseable[0]?.filePath).toBe(bad);
			expect(unparseable[0]?.story).toBeNull();
			// The good file was still linted — the run did not stop at the bad one.
			expect(report.files).toHaveLength(2);
			expect(report.errors).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * We refuse to READ a nested dependency edge; we must also refuse to WRITE one.
 *
 * The dependency verbs decline to answer once such an edge exists, but
 * planestories would happily create it: `parent: EPIC-1` plus
 * `blocked_by: [EPIC-1]` passed lint, and Plane's API accepts it (verified —
 * HTTP 201 on a sandbox). A tool that declines to read a state it will write is
 * incoherent. This is the other half.
 */
describe("dependency-nested", () => {
	test("a child blocked by its own parent is a finding", async () => {
		const epic = writeMarkdown("e.md", story("Epic", ["kind: epic", "plane_identifier: N-1"], WHY));
		const child = writeMarkdown(
			"c.md",
			story(
				"Child",
				["plane_identifier: N-2", "parent: N-1", "blocked_by: [N-1]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);
		const report = await lintFiles([child, epic]);
		const nested = report.findings.filter((f) => f.rule === "dependency-nested");
		expect(nested).toHaveLength(1);
		expect(nested[0]?.message).toContain("N-1");
		expect(nested[0]?.message).toMatch(/remove the relation|re-parent/i);
	});

	test("a GRANDparent counts too — the whole chain, not just one hop", async () => {
		const root = writeMarkdown("r.md", story("Root", ["kind: epic", "plane_identifier: N-1"], WHY));
		const mid = writeMarkdown(
			"m.md",
			story("Mid", ["kind: epic", "plane_identifier: N-2", "parent: N-1"], WHY),
		);
		const leaf = writeMarkdown(
			"l.md",
			story(
				"Leaf",
				["plane_identifier: N-3", "parent: N-2", "blocks: [N-1]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);
		const report = await lintFiles([leaf, mid, root]);
		expect(report.findings.filter((f) => f.rule === "dependency-nested")).toHaveLength(1);
	});

	test("an ordinary sibling dependency is NOT a finding", async () => {
		// The rule must not spread to the relations people actually want.
		const a = writeMarkdown(
			"a.md",
			story("A", ["plane_identifier: N-9"], `${EFFORT}\n\n${CRITERIA}`),
		);
		const b = writeMarkdown(
			"b.md",
			story("B", ["plane_identifier: N-8", "blocked_by: [N-9]"], `${EFFORT}\n\n${CRITERIA}`),
		);
		const report = await lintFiles([a, b]);
		expect(report.findings.filter((f) => f.rule === "dependency-nested")).toEqual([]);
	});
});

/**
 * The rule list must not exist twice.
 *
 * `repo_config.ts` kept a hand-copied set for validating `lint.disable`, and it
 * went stale the moment a rule was added — `.planestories.yml` with
 * `lint.disable: [dependency-nested]` failed startup saying "unknown rule",
 * which was false. This asserts the two can never drift again.
 */
describe("every lint rule can be disabled", () => {
	test("the exported list covers every rule the linter can emit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lint-rules-"));
		try {
			for (const rule of ALL_LINT_RULES) {
				writeFileSync(join(dir, ".planestories.yml"), `lint:\n  disable:\n    - ${rule}\n`);
				// Loading must accept every name the union permits.
				await expect(loadRepoConfig(dir), rule).resolves.toBeDefined();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an invented rule name is still rejected", async () => {
		// The validation must not have been loosened into uselessness.
		const dir = mkdtempSync(join(tmpdir(), "lint-rules-bad-"));
		try {
			writeFileSync(join(dir, ".planestories.yml"), "lint:\n  disable:\n    - not-a-rule\n");
			await expect(loadRepoConfig(dir)).rejects.toThrow(/unknown/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * `dependency-nested` has to fire BEFORE the first import.
 *
 * The rule keyed on `plane_identifier`, which does not exist until import writes
 * it back — so it only caught work already on the board and prevented nothing on
 * the path it was built for: someone authoring a new file. Measured: zero
 * findings on a brand-new child declaring `blocked_by` on its own parent.
 */
test("a NEW story with no identifier is still caught", async () => {
	const epic = writeMarkdown("ne.md", story("Epic", ["kind: epic", "plane_identifier: X-1"], WHY));
	const child = writeMarkdown(
		"nc.md",
		// No plane_identifier — this file has never been imported.
		story("Fresh child", ["parent: X-1", "blocked_by: [X-1]"], `${EFFORT}\n\n${CRITERIA}`),
	);
	const report = await lintFiles([child, epic]);
	const nested = report.findings.filter((f) => f.rule === "dependency-nested");
	expect(nested).toHaveLength(1);
	// Named by title, since there is no identifier to name it by.
	expect(nested[0]?.message).toContain("Fresh child");
});
