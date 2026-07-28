import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFiles } from "../../../src/lint/linter.ts";
import { type LintRule, runLintRules } from "../../../src/lint/rules.ts";
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
		expect(report.findings.map((finding) => finding.story.title)).toEqual(["First", "Second"]);
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
		const child = writeMarkdown(
			"child.md",
			story(
				"Cross-file child",
				["plane_identifier: APP-2", "parent: APP-1", "blocked_by: [APP-1]"],
				`${EFFORT}\n\n${CRITERIA}`,
			),
		);

		const report = await lintFiles([child, epic]);

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
		expect(report.findings[0]?.story.title).toBe("Case-mismatched parent");
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
