import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader.ts";
import { ConfigError } from "../../../src/errors.ts";

describe("config rate profile", () => {
	const originalEnv = process.env;
	let dir: string;
	let path: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PLANE_")) delete process.env[key];
		}
		dir = mkdtempSync(join(tmpdir(), "planestories-rate-profile-"));
		path = join(dir, "config.json");
	});

	afterEach(() => {
		process.env = originalEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	for (const [raw, expected] of [
		["60/minute", 60],
		[60, 60],
		["60 / minute", 60],
	] as const) {
		test(`parses ${JSON.stringify(raw)} as ${expected} rpm`, async () => {
			writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws", apiRateLimit: raw }));
			expect((await loadConfig({ configPath: path })).apiRateLimit).toBe(expected);
		});
	}

	for (const raw of ["fast", 0, -5, "60/hour"]) {
		test(`rejects invalid apiRateLimit ${JSON.stringify(raw)}`, async () => {
			writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws", apiRateLimit: raw }));
			await expect(loadConfig({ configPath: path })).rejects.toBeInstanceOf(ConfigError);
			await expect(loadConfig({ configPath: path })).rejects.toThrow("apiRateLimit");
		});
	}

	test("rejects rateHeadroom outside (0, 1]", async () => {
		writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws", rateHeadroom: 1.5 }));
		await expect(loadConfig({ configPath: path })).rejects.toThrow("rateHeadroom");
	});

	test("resolves the optional concurrency controls", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				apiKey: "k",
				workspaceSlug: "ws",
				apiRateLimit: "600/minute",
				maxConcurrency: 24,
				rateHeadroom: 0.7,
			}),
		);
		expect(await loadConfig({ configPath: path })).toMatchObject({
			apiRateLimit: 600,
			maxConcurrency: 24,
			rateHeadroom: 0.7,
		});
	});

	test("isolates named-context rate env from the bare rate env", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				contexts: [{ name: "ce", apiKey: "k", workspaceSlug: "ws" }],
			}),
		);
		process.env.PLANE_API_RATE_LIMIT = "60/minute";
		process.env.PLANE_CTX_CE_API_RATE_LIMIT = "600/minute";
		expect((await loadConfig({ configPath: path, context: "ce" })).apiRateLimit).toBe(600);

		delete process.env.PLANE_CTX_CE_API_RATE_LIMIT;
		expect((await loadConfig({ configPath: path, context: "ce" })).apiRateLimit).toBeUndefined();
	});

	test("uses the bare rate env on the default path", async () => {
		writeFileSync(path, JSON.stringify({ apiKey: "k", workspaceSlug: "ws" }));
		process.env.PLANE_API_RATE_LIMIT = "600/minute";
		expect((await loadConfig({ configPath: path })).apiRateLimit).toBe(600);
	});
});
