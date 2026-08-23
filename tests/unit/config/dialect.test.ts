import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader.ts";
import { ConfigError } from "../../../src/errors.ts";

describe("config endpoint dialect", () => {
	const originalEnv = process.env;
	let dir: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		for (const key of Object.keys(process.env))
			if (key.startsWith("PLANE_")) delete process.env[key];
		dir = mkdtempSync(join(tmpdir(), "planestories-dialect-"));
	});

	afterEach(() => {
		process.env = originalEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	test("preserves an absent dialect and reads flat file/env with env precedence", async () => {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws" }));
		const absent = await loadConfig({ configPath: path });
		expect(absent.dialect).toBeUndefined();
		expect(absent.dialectSource).toBeUndefined();
		writeFileSync(
			path,
			JSON.stringify({ apiKey: "k", workspaceSlug: "ws", dialect: "work-items" }),
		);
		const configured = await loadConfig({ configPath: path });
		expect(configured.dialect).toBe("work-items");
		expect(configured.dialectSource).toBe("configured");
		process.env.PLANE_DIALECT = "issues";
		expect((await loadConfig({ configPath: path })).dialect).toBe("issues");
	});

	test("reads per-context file/env and ignores the bare env", async () => {
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				contexts: [{ name: "ce", apiKey: "k", workspaceSlug: "ws", dialect: "work-items" }],
			}),
		);
		process.env.PLANE_DIALECT = "issues";
		expect((await loadConfig({ configPath: path, context: "ce" })).dialect).toBe("work-items");
		process.env.PLANE_CTX_CE_DIALECT = "issues";
		expect((await loadConfig({ configPath: path, context: "ce" })).dialect).toBe("issues");
	});

	test("present invalid file and env values name their source", async () => {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws", dialect: "legacy" }));
		await expect(loadConfig({ configPath: path })).rejects.toThrow(ConfigError);
		await expect(loadConfig({ configPath: path })).rejects.toThrow('field "dialect"');
		writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws" }));
		process.env.PLANE_DIALECT = "legacy";
		await expect(loadConfig({ configPath: path })).rejects.toThrow("PLANE_DIALECT");
	});
});
