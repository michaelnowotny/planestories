import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
const cliPath = join(import.meta.dir, "../../../src/cli/index.ts");

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-lint-command-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function missingEffortFile(): string {
	const filePath = join(directory, "stories.md");
	writeFileSync(
		filePath,
		[
			"## Needs effort",
			"",
			"```yaml",
			"plane_identifier: APP-1",
			"```",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] It works",
			"",
		].join("\n"),
	);
	return filePath;
}

function cycleFile(name: string, identifier: string, blocks: string): string {
	const filePath = join(directory, name);
	writeFileSync(
		filePath,
		[
			`## ${identifier}`,
			"",
			"```yaml",
			`plane_identifier: ${identifier}`,
			`blocks: [${blocks}]`,
			"```",
			"",
			"**Effort:** 1 dev-day",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] It works",
			"",
		].join("\n"),
	);
	return filePath;
}

function runLint(...args: string[]) {
	return Bun.spawnSync({
		cmd: [process.execPath, cliPath, "lint", ...args],
		env: { ...process.env, FORCE_COLOR: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("lint command", () => {
	test("prints grouped findings and exits one for hard violations", () => {
		const filePath = missingEffortFile();

		const result = runLint(filePath);
		const output = result.stdout.toString();

		expect(result.exitCode).toBe(1);
		expect(output).toContain(`Lint ${filePath}`);
		expect(output).toContain("ERROR missing-effort: Needs effort / APP-1");
		expect(output).toContain("1 error, 0 warnings across 1 file.");
		expect(result.stderr.toString()).toBe("");
	});

	test("--warn-only downgrades output and exits zero", () => {
		const result = runLint(missingEffortFile(), "--warn-only");
		const output = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(output).toContain("WARNING missing-effort: Needs effort / APP-1");
		expect(output).toContain("0 errors, 1 warning across 1 file.");
		expect(result.stderr.toString()).toBe("");
	});

	test("prints a cross-file cycle finding under every affected file", () => {
		const first = cycleFile("first.md", "APP-1", "APP-2");
		const second = cycleFile("second.md", "APP-2", "APP-1");

		const result = runLint(first, second);
		const output = result.stdout.toString();

		expect(result.exitCode).toBe(1);
		expect(output).toContain(`Lint ${first}`);
		expect(output).toContain(`Lint ${second}`);
		expect(output.match(/ERROR dependency-cycle/g)).toHaveLength(2);
		expect(output).not.toContain("Clean — no convention violations found.");
		expect(output).toContain("2 errors, 0 warnings across 2 files.");
	});

	test("documents strict defaults without exposing the dead --strict option", () => {
		const result = runLint("--help");
		const output = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(output).toContain("strict by default; use --warn-only to");
		expect(output).toContain("downgrade");
		expect(output).not.toContain("--strict");
	});
});
