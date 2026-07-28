import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findRepoConfigPath,
	loadRepoConfig,
	REPO_CONFIG_FILENAME,
	validateRepoConfig,
} from "../../../src/config/repo_config.ts";
import { ConfigError } from "../../../src/errors.ts";

describe("validateRepoConfig", () => {
	test("accepts an empty object", () => {
		expect(validateRepoConfig({}, "x")).toEqual({});
	});

	test("accepts strictness + disable", () => {
		const cfg = validateRepoConfig(
			{ lint: { strictness: "warn", disable: ["missing-effort"] } },
			"x",
		);
		expect(cfg).toEqual({ lint: { strictness: "warn", disable: ["missing-effort"] } });
	});

	test("rejects an unknown top-level key", () => {
		expect(() => validateRepoConfig({ project: "X" }, "x")).toThrow(ConfigError);
	});

	test("rejects an unknown lint key", () => {
		expect(() => validateRepoConfig({ lint: { nope: 1 } }, "x")).toThrow(ConfigError);
	});

	test("rejects a bad strictness value", () => {
		expect(() => validateRepoConfig({ lint: { strictness: "loud" } }, "x")).toThrow(ConfigError);
	});

	test("rejects an unknown rule in disable", () => {
		expect(() => validateRepoConfig({ lint: { disable: ["not-a-rule"] } }, "x")).toThrow(
			ConfigError,
		);
	});

	test("rejects a non-list disable", () => {
		expect(() => validateRepoConfig({ lint: { disable: "missing-effort" } }, "x")).toThrow(
			ConfigError,
		);
	});

	test("rejects a non-object root (null / array / primitive) with ConfigError, not a crash", () => {
		expect(() => validateRepoConfig(null, "x")).toThrow(ConfigError);
		expect(() => validateRepoConfig([], "x")).toThrow(ConfigError);
		expect(() => validateRepoConfig(false, "x")).toThrow(ConfigError);
		expect(() => validateRepoConfig("hello", "x")).toThrow(ConfigError);
	});
});

describe("loadRepoConfig / findRepoConfigPath", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "repocfg-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns an empty config when no file exists", async () => {
		const nested = join(tmpDir, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findRepoConfigPath(nested)).toBeNull();
		expect(await loadRepoConfig(nested)).toEqual({});
	});

	test("discovers the file in an ANCESTOR directory", async () => {
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "lint:\n  strictness: warn\n");
		const nested = join(tmpDir, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findRepoConfigPath(nested)).toBe(join(tmpDir, REPO_CONFIG_FILENAME));
		expect(await loadRepoConfig(nested)).toEqual({ lint: { strictness: "warn" } });
	});

	test("a present-but-invalid file fails loudly", async () => {
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "lint:\n  strictness: loud\n");
		await expect(loadRepoConfig(tmpDir)).rejects.toBeInstanceOf(ConfigError);
	});

	test("parses a disable list", async () => {
		writeFileSync(
			join(tmpDir, REPO_CONFIG_FILENAME),
			"lint:\n  disable:\n    - missing-effort\n    - missing-acceptance-criteria\n",
		);
		expect(await loadRepoConfig(tmpDir)).toEqual({
			lint: { disable: ["missing-effort", "missing-acceptance-criteria"] },
		});
	});

	test("a LEADING `---` (YAML doc-start) does NOT silently empty the config", async () => {
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "---\nlint:\n  strictness: warn\n");
		expect(await loadRepoConfig(tmpDir)).toEqual({ lint: { strictness: "warn" } });
	});

	test("a mid-file `---` (multiple documents) fails loudly, not silently truncated", async () => {
		writeFileSync(
			join(tmpDir, REPO_CONFIG_FILENAME),
			"lint:\n  strictness: error\n---\nlint:\n  strictness: warn\n",
		);
		await expect(loadRepoConfig(tmpDir)).rejects.toBeInstanceOf(ConfigError);
	});

	test("a non-mapping root (false / a list) fails loudly, not treated as empty", async () => {
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "false\n");
		await expect(loadRepoConfig(tmpDir)).rejects.toBeInstanceOf(ConfigError);
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "- a\n- b\n");
		await expect(loadRepoConfig(tmpDir)).rejects.toBeInstanceOf(ConfigError);
	});

	test("an empty / comment-only file is a legitimately empty config", async () => {
		writeFileSync(join(tmpDir, REPO_CONFIG_FILENAME), "# just a comment\n");
		expect(await loadRepoConfig(tmpDir)).toEqual({});
	});

	test("discovery finds a config INSIDE the repo (at the .git root or above cwd)", async () => {
		// tmpDir/repo/.git + tmpDir/repo/.planestories.yml ; search from tmpDir/repo/sub
		const repo = join(tmpDir, "repo");
		const sub = join(repo, "sub");
		mkdirSync(sub, { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(repo, REPO_CONFIG_FILENAME), "lint:\n  strictness: warn\n");
		expect(findRepoConfigPath(sub)).toBe(join(repo, REPO_CONFIG_FILENAME));
		expect(await loadRepoConfig(sub)).toEqual({ lint: { strictness: "warn" } });
	});

	test("discovery stops at the repo root (.git) — a config ABOVE the repo is ignored", async () => {
		// tmpDir/above/.planestories.yml  <- must NOT be found
		// tmpDir/above/repo/.git          <- repo boundary
		// tmpDir/above/repo/sub           <- search starts here
		const above = join(tmpDir, "above");
		const repo = join(above, "repo");
		const sub = join(repo, "sub");
		mkdirSync(sub, { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(above, REPO_CONFIG_FILENAME), "lint:\n  strictness: warn\n");
		expect(findRepoConfigPath(sub)).toBeNull();
		expect(await loadRepoConfig(sub)).toEqual({});
	});
});
