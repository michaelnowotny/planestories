import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigForSnapshot } from "../../../src/cli/snapshot_option.ts";

/**
 * The offline path must not require credentials — but it must not become a place where
 * config errors go to die either. Only the two secret assertions are optional.
 */
describe("loadConfigForSnapshot", () => {
	// `loadConfig` reads process.env directly, and several other suites set PLANE_*
	// vars to exercise their own paths. Sharing one process means ambient env can leak
	// in and make these assertions fail (or pass) for reasons that have nothing to do
	// with the code under test — observed as an intermittent failure only in FULL runs.
	// Isolate what we depend on rather than hoping about ordering.
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PLANE_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	/**
	 * Async, and it AWAITS the callback before removing the directory.
	 *
	 * It used to be synchronous while every caller passed an `async` body, so
	 * `run(dir)` returned a pending promise and `finally` deleted the temp
	 * directory immediately — while `loadConfig` was still reading the file inside
	 * it. The test then passed or failed depending on which won the race, roughly
	 * one run in ten. HANDOFF §9.5a recorded this as ambient-`PLANE_*` leakage
	 * between suites; it was a use-after-free of the fixture directory.
	 */
	async function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
		const dir = mkdtempSync(join(tmpdir(), "planestories-cfg-"));
		try {
			return await run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("a present config file is HONOURED, not discarded", async () => {
		await withDir(async (dir) => {
			const file = join(dir, "conventions.json");
			writeFileSync(file, JSON.stringify({ defaultProject: "DATA", defaultLabels: ["ops"] }));
			const config = await loadConfigForSnapshot(file, undefined);
			// The bug this pins: a catch-all fallback returned neutral defaults and
			// silently threw the user's conventions away.
			expect(config.defaultProject).toBe("DATA");
			expect(config.defaultLabels).toEqual(["ops"]);
		});
	});

	test("no credentials is fine, and no production URL is invented", async () => {
		const config = await loadConfigForSnapshot(undefined, undefined);
		expect(config.defaultProject === null || typeof config.defaultProject === "string").toBe(true);
		// A snapshot run must never look like a live instance.
		expect(config.baseUrl).not.toContain("api.plane.so");
	});

	test("a malformed config still fails LOUDLY", async () => {
		await withDir(async (dir) => {
			const file = join(dir, "broken.json");
			writeFileSync(file, "{not json");
			await expect(loadConfigForSnapshot(file, undefined)).rejects.toThrow();
		});
	});

	test("a missing --config path still fails LOUDLY", async () => {
		await expect(loadConfigForSnapshot("/no/such/config.json", undefined)).rejects.toThrow(
			/not found/i,
		);
	});
});
