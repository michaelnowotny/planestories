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
});
