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
			sourceLabel: null,
			maxRetries: 5,
		} satisfies ResolvedConfig);
	});

	test("PLANE_API_KEY env var overrides apiKey in config", async () => {
		process.env.PLANE_API_KEY = "plane_api_from_env";
		const configPath = join(FIXTURES_DIR, "valid.json");

		const config = await loadConfig({ configPath });
		expect(config.apiKey).toBe("plane_api_from_env");
	});

	test("reads sourceLabel from config; PLANE_SOURCE_LABEL overrides it; default null", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-srclabel-"));
		try {
			const rcPath = join(tempDir, ".planestoriesrc.json");
			writeFileSync(
				rcPath,
				JSON.stringify({ apiKey: "k", workspaceSlug: "ws", sourceLabel: "planestories" }),
			);

			const fromConfig = await loadConfig({ configPath: rcPath });
			expect(fromConfig.sourceLabel).toBe("planestories");

			process.env.PLANE_SOURCE_LABEL = "from-env";
			const fromEnv = await loadConfig({ configPath: rcPath });
			expect(fromEnv.sourceLabel).toBe("from-env");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("sourceLabel defaults to null when unset", async () => {
		const config = await loadConfig({ configPath: join(FIXTURES_DIR, "minimal.json") });
		expect(config.sourceLabel).toBeNull();
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

		test("throws when --context specified but config is flat (and no env-only profile)", async () => {
			const configPath = join(FIXTURES_DIR, "valid.json");
			expect(loadConfig({ configPath, context: "orgA" })).rejects.toThrow("PLANE_CTX_ORGA_API_KEY");
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

		// CHANGED CONTRACT (replicate P1): bare PLANE_API_KEY no longer clobbers a
		// NAMED context — per-context PLANE_CTX_<NAME>_API_KEY is the only override.
		// The old behavior silently gave both sides of a --from/--to pair the same
		// credentials.
		test("bare PLANE_API_KEY does NOT override a selected context's apiKey", async () => {
			process.env.PLANE_API_KEY = "plane_api_from_env_override";
			const configPath = join(FIXTURES_DIR, "multi-context.json");
			const config = await loadConfig({ configPath, context: "orgA" });

			expect(config.apiKey).toBe("plane_api_orgA_key123");
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

describe("per-context credential isolation (replicate P1)", () => {
	const originalEnv = process.env;
	const MULTI = join(FIXTURES_DIR, "multi-context.json");

	beforeEach(() => {
		process.env = { ...originalEnv };
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("PLANE_")) delete process.env[k];
		}
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("bare PLANE_* env does NOT clobber a named context (the dual-profile fix)", async () => {
		// The old behavior: one global key silently overwrote BOTH sides of a
		// --from/--to pair. A named context must resolve its own credentials.
		process.env.PLANE_API_KEY = "cloud-key-must-not-leak";
		process.env.PLANE_WORKSPACE_SLUG = "cloud-ws-must-not-leak";
		const config = await loadConfig({ configPath: MULTI, context: "orgA" });
		expect(config.apiKey).toBe("plane_api_orgA_key123");
		expect(config.workspaceSlug).toBe("org-a");
	});

	test("bare PLANE_* env still applies on the flat/default path (back-compat)", async () => {
		process.env.PLANE_API_KEY = "env-key";
		process.env.PLANE_WORKSPACE_SLUG = "env-ws";
		const config = await loadConfig({ configPath: join(FIXTURES_DIR, "valid.json") });
		expect(config.apiKey).toBe("env-key");
		expect(config.workspaceSlug).toBe("env-ws");
	});

	test("PLANE_CTX_<NAME>_* env overrides the selected context's file values", async () => {
		process.env.PLANE_CTX_ORGA_API_KEY = "ctx-env-key";
		process.env.PLANE_CTX_ORGA_BASE_URL = "https://ce.example.com";
		const config = await loadConfig({ configPath: MULTI, context: "orgA" });
		expect(config.apiKey).toBe("ctx-env-key");
		expect(config.baseUrl).toBe("https://ce.example.com");
		expect(config.workspaceSlug).toBe("org-a"); // untouched fields keep file values
	});

	test("env-only context: no multi-context file needed when PLANE_CTX_<NAME>_* is set", async () => {
		process.env.PLANE_CTX_CE_API_KEY = "ce-key";
		process.env.PLANE_CTX_CE_WORKSPACE_SLUG = "archimedes";
		process.env.PLANE_CTX_CE_BASE_URL = "https://plane.example.works";
		// flat config file on disk; the named context resolves purely from env
		const config = await loadConfig({
			configPath: join(FIXTURES_DIR, "valid.json"),
			context: "ce",
		});
		expect(config.apiKey).toBe("ce-key");
		expect(config.workspaceSlug).toBe("archimedes");
		expect(config.baseUrl).toBe("https://plane.example.works");
	});

	test("context names normalize for env lookup (dashes -> underscores, case-insensitive)", async () => {
		process.env["PLANE_CTX_MY_VPS_API_KEY"] = "vps-key";
		process.env["PLANE_CTX_MY_VPS_WORKSPACE_SLUG"] = "vps-ws";
		const config = await loadConfig({
			configPath: join(FIXTURES_DIR, "valid.json"),
			context: "my-vps",
		});
		expect(config.apiKey).toBe("vps-key");
	});

	test("unknown context with no env profile fails with the per-context env name in the message", async () => {
		await expect(
			loadConfig({ configPath: join(FIXTURES_DIR, "valid.json"), context: "nope" }),
		).rejects.toThrow("PLANE_CTX_NOPE_API_KEY");
	});

	test("named context missing its key mentions the per-context env var, not the bare one", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-ctx-"));
		try {
			const rcPath = join(tempDir, "ctx.json");
			writeFileSync(
				rcPath,
				JSON.stringify({ contexts: [{ name: "keyless", workspaceSlug: "ws" }] }),
			);
			process.env.PLANE_API_KEY = "bare-key-should-not-satisfy";
			await expect(loadConfig({ configPath: rcPath, context: "keyless" })).rejects.toThrow(
				"PLANE_CTX_KEYLESS_API_KEY",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("context-name normalization safety (Codex P1)", () => {
	const originalEnv = process.env;
	beforeEach(() => {
		process.env = { ...originalEnv };
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("PLANE_")) delete process.env[k];
		}
	});
	afterEach(() => {
		process.env = originalEnv;
	});

	test("two contexts whose names normalize identically are rejected at load", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-collide-"));
		try {
			const rcPath = join(tempDir, "collide.json");
			writeFileSync(
				rcPath,
				JSON.stringify({
					contexts: [
						{ name: "a-b", apiKey: "k1", workspaceSlug: "w1" },
						{ name: "a_b", apiKey: "k2", workspaceSlug: "w2" },
					],
				}),
			);
			await expect(loadConfig({ configPath: rcPath, context: "a-b" })).rejects.toThrow(
				"normalize to the same",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("a DEFINED context whose name normalizes to nothing is rejected even when another context is selected", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "planestories-emptynorm-"));
		try {
			const rcPath = join(tempDir, "emptynorm.json");
			writeFileSync(
				rcPath,
				JSON.stringify({
					contexts: [
						{ name: "good", apiKey: "k1", workspaceSlug: "w1" },
						{ name: "--", apiKey: "k2", workspaceSlug: "w2" },
					],
				}),
			);
			await expect(loadConfig({ configPath: rcPath, context: "good" })).rejects.toThrow(
				"normalizes to nothing",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("a context name that normalizes to nothing is rejected", async () => {
		process.env["PLANE_CTX__API_KEY"] = "k";
		await expect(
			loadConfig({ configPath: join(FIXTURES_DIR, "valid.json"), context: "--" }),
		).rejects.toThrow("normalizes to nothing");
	});
});
