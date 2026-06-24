import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader.ts";
import { ConfigError } from "../../../src/errors.ts";
import type { ResolvedConfig } from "../../../src/types.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/configs");

describe("loadConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		// Clone env so we can safely mutate it per test
		process.env = { ...originalEnv };
		// Remove PLANE_* so they don't leak between tests
		delete process.env.PLANE_API_KEY;
		delete process.env.PLANE_WORKSPACE_SLUG;
		delete process.env.PLANE_BASE_URL;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("loads config from explicit path (--config flag)", async () => {
		const configPath = join(FIXTURES_DIR, "valid.json");
		const config = await loadConfig({ configPath });

		expect(config.apiKey).toBe("plane_api_test1234567890abcdef");
		expect(config.workspaceSlug).toBe("engineering-ws");
		expect(config.defaultProject).toBe("Q1 2026 Release");
		expect(config.defaultLabels).toEqual(["User Story"]);
	});

	test("throws ConfigError when explicit path doesn't exist", async () => {
		const bogusPath = join(FIXTURES_DIR, "nonexistent.json");
		expect(loadConfig({ configPath: bogusPath })).rejects.toThrow(ConfigError);
	});

	test("discovers .planestoriesrc.json in current working directory", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-test-"));
		try {
			const rcPath = join(tempDir, ".planestoriesrc.json");
			writeFileSync(
				rcPath,
				JSON.stringify({ apiKey: "plane_api_from_cwd_rc", workspaceSlug: "ws" }),
			);

			const config = await loadConfig({ cwd: tempDir });
			expect(config.apiKey).toBe("plane_api_from_cwd_rc");
			expect(config.workspaceSlug).toBe("ws");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("falls back to ~/.config/planestories/config.json", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "planestories-home-"));
		try {
			const configDir = join(tempHome, ".config", "planestories");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify({ apiKey: "plane_api_from_home", workspaceSlug: "home-ws" }),
			);

			const emptyCwd = mkdtempSync(join(tmpdir(), "planestories-empty-"));
			process.env.HOME = tempHome;

			const config = await loadConfig({ cwd: emptyCwd });
			expect(config.apiKey).toBe("plane_api_from_home");

			rmSync(emptyCwd, { recursive: true, force: true });
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	test("parses all JSON fields correctly", async () => {
		const configPath = join(FIXTURES_DIR, "valid.json");
		const config = await loadConfig({ configPath });

		expect(config).toEqual({
			apiKey: "plane_api_test1234567890abcdef",
			workspaceSlug: "engineering-ws",
			baseUrl: "https://api.plane.so",
			defaultProject: "Q1 2026 Release",
			defaultLabels: ["User Story"],
		} satisfies ResolvedConfig);
	});

	test("PLANE_API_KEY env var overrides apiKey in config", async () => {
		process.env.PLANE_API_KEY = "plane_api_from_env";
		const configPath = join(FIXTURES_DIR, "valid.json");

		const config = await loadConfig({ configPath });
		expect(config.apiKey).toBe("plane_api_from_env");
	});

	test("PLANE_BASE_URL env var overrides baseUrl", async () => {
		process.env.PLANE_BASE_URL = "https://plane.internal.example.com";
		const configPath = join(FIXTURES_DIR, "valid.json");

		const config = await loadConfig({ configPath });
		expect(config.baseUrl).toBe("https://plane.internal.example.com");
	});

	test("throws ConfigError when no API key from any source", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-nokey-"));
		try {
			const rcPath = join(tempDir, ".planestoriesrc.json");
			writeFileSync(rcPath, JSON.stringify({ workspaceSlug: "ws" }));

			expect(loadConfig({ configPath: rcPath })).rejects.toThrow(ConfigError);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("throws ConfigError when no workspace slug from any source", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-noslug-"));
		try {
			const rcPath = join(tempDir, ".planestoriesrc.json");
			writeFileSync(rcPath, JSON.stringify({ apiKey: "plane_api_x" }));

			expect(loadConfig({ configPath: rcPath })).rejects.toThrow(ConfigError);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("throws ConfigError on malformed JSON", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-bad-json-"));
		try {
			const badPath = join(tempDir, "bad.json");
			writeFileSync(badPath, "{ this is not valid json }}}");

			expect(loadConfig({ configPath: badPath })).rejects.toThrow(ConfigError);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns defaults for missing optional fields", async () => {
		const configPath = join(FIXTURES_DIR, "minimal.json");
		const config = await loadConfig({ configPath });

		expect(config.apiKey).toBe("plane_api_minimalkey1234567890");
		expect(config.workspaceSlug).toBe("minimal-ws");
		expect(config.baseUrl).toBe("https://api.plane.so");
		expect(config.defaultProject).toBeNull();
		expect(config.defaultLabels).toEqual([]);
	});

	describe("multi-context config", () => {
		test("selects correct context by name (orgA)", async () => {
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			const config = await loadConfig({ configPath, context: "orgA" });

			expect(config.apiKey).toBe("plane_api_orgA_key123");
			expect(config.workspaceSlug).toBe("org-a");
			expect(config.defaultProject).toBe("Q1 Release");
			expect(config.defaultLabels).toEqual(["User Story", "Feature"]);
		});

		test("selects different context (orgB)", async () => {
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			const config = await loadConfig({ configPath, context: "orgB" });

			expect(config.apiKey).toBe("plane_api_orgB_key456");
			expect(config.workspaceSlug).toBe("org-b");
			expect(config.defaultProject).toBe("Brand Refresh");
			expect(config.defaultLabels).toEqual(["Design Task"]);
		});

		test("throws when --context specified but config is flat", async () => {
			const configPath = join(FIXTURES_DIR, "valid.json");
			expect(loadConfig({ configPath, context: "orgA" })).rejects.toThrow(
				"--context flag was specified but the config file does not use the multi-context format",
			);
		});

		test("throws when config has contexts but no --context provided", async () => {
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			expect(loadConfig({ configPath })).rejects.toThrow(
				"Config file contains multiple contexts. Use --context <name> to select one. Available contexts: orgA, orgB",
			);
		});

		test("throws when --context name not found", async () => {
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			expect(loadConfig({ configPath, context: "foo" })).rejects.toThrow(
				'Context "foo" not found. Available contexts: orgA, orgB',
			);
		});

		test("PLANE_API_KEY env var overrides selected context's apiKey", async () => {
			process.env.PLANE_API_KEY = "plane_api_from_env_override";
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			const config = await loadConfig({ configPath, context: "orgA" });

			expect(config.apiKey).toBe("plane_api_from_env_override");
		});

		test("fills defaults for missing optional fields in context", async () => {
			const configPath = join(FIXTURES_DIR, "multi-context-minimal.json");
			const config = await loadConfig({ configPath, context: "dev" });

			expect(config.apiKey).toBe("plane_api_dev_minimal");
			expect(config.workspaceSlug).toBe("dev-ws");
			expect(config.defaultProject).toBeNull();
			expect(config.defaultLabels).toEqual([]);
		});

		test("flat config still works without --context (regression)", async () => {
			const configPath = join(FIXTURES_DIR, "valid.json");
			const config = await loadConfig({ configPath });

			expect(config.apiKey).toBe("plane_api_test1234567890abcdef");
			expect(config.workspaceSlug).toBe("engineering-ws");
		});
	});
});
