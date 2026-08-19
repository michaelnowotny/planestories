import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader.ts";

/**
 * `defaultContext` + single-context auto-default (HANDOFF §9.6).
 *
 * The feature is small; the SAFETY property is not. When a context is chosen
 * IMPLICITLY it must be as isolated from the bare `PLANE_*` env vars as one
 * chosen with `--context`. Otherwise a cloud key sitting in the environment —
 * which is the normal state of the operator's shell — could silently
 * authenticate a command aimed at the self-hosted CE board. That is the exact
 * cross-instance clobber the per-context contract exists to prevent, and a
 * convenience default is not allowed to reopen it.
 */

let directory: string;
const SAVED: Record<string, string | undefined> = {};

/** `loadConfig` reads `process.env` directly, so isolate it per test (§9.5a #2). */
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-defaultctx-"));
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) {
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) delete process.env[key];
	}
	for (const [key, value] of Object.entries(SAVED)) {
		if (value !== undefined) process.env[key] = value;
		delete SAVED[key];
	}
});

function writeConfig(config: unknown): string {
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

const ce = {
	name: "ce",
	apiKey: "ce-key",
	workspaceSlug: "archimedes",
	baseUrl: "https://plane.example.internal/api/v1",
};
const cloud = {
	name: "cloud",
	apiKey: "cloud-key",
	workspaceSlug: "cloudws",
	baseUrl: "https://api.plane.so/api/v1",
};

describe("defaultContext", () => {
	test("is used when --context is omitted", async () => {
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "ce" });
		const resolved = await loadConfig({ configPath });
		expect(resolved.apiKey).toBe("ce-key");
		expect(resolved.workspaceSlug).toBe("archimedes");
	});

	test("an explicit --context still wins over it", async () => {
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "ce" });
		const resolved = await loadConfig({ configPath, context: "cloud" });
		expect(resolved.apiKey).toBe("cloud-key");
	});

	test("naming a context that does not exist is a STARTUP ERROR, not a fallback", async () => {
		// Present-but-invalid config fails loudly. Falling back to "some other
		// context" would point a command at the wrong Plane installation, which is
		// the failure this whole contract exists to prevent.
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "typo" });
		expect(loadConfig({ configPath })).rejects.toThrow(/defaultContext "typo" does not name any/);
	});

	test("the dangling-default error fires even when --context WOULD have worked", async () => {
		// A broken config is broken. Validating only on the path that consults it
		// would leave the mistake latent until the day somebody omits the flag.
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "typo" });
		expect(loadConfig({ configPath, context: "ce" })).rejects.toThrow(/does not name any/);
	});
});

describe("single-context auto-default", () => {
	test("one context needs no --context", async () => {
		// The old behaviour demanded a flag naming the only thing the config could
		// possibly mean.
		const configPath = writeConfig({ contexts: [ce] });
		const resolved = await loadConfig({ configPath });
		expect(resolved.apiKey).toBe("ce-key");
	});

	test("two contexts and no default still refuses, and lists them", async () => {
		const configPath = writeConfig({ contexts: [cloud, ce] });
		expect(loadConfig({ configPath })).rejects.toThrow(/Available contexts: cloud, ce/);
	});
});

describe("⚠ implicit selection keeps per-context credential isolation", () => {
	test("bare PLANE_API_KEY does NOT override an auto-selected single context", async () => {
		// The load-bearing case. The operator's shell routinely carries a cloud
		// PLANE_API_KEY; a CE-only config auto-selecting its one context must not
		// pick that key up, or the command silently authenticates against the wrong
		// installation while every message says "ce".
		process.env.PLANE_API_KEY = "ambient-cloud-key";
		process.env.PLANE_WORKSPACE_SLUG = "ambient-cloud-ws";
		const configPath = writeConfig({ contexts: [ce] });

		const resolved = await loadConfig({ configPath });

		expect(resolved.apiKey).toBe("ce-key");
		expect(resolved.workspaceSlug).toBe("archimedes");
	});

	test("bare PLANE_API_KEY does NOT override a defaultContext selection either", async () => {
		process.env.PLANE_API_KEY = "ambient-cloud-key";
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "ce" });

		const resolved = await loadConfig({ configPath });

		expect(resolved.apiKey).toBe("ce-key");
	});

	test("the context's OWN PLANE_CTX_* vars still apply when selected implicitly", async () => {
		// Isolation must not become inertness: per-context overrides are how
		// credentials stay out of the committed file, so they have to work on the
		// implicit path too.
		process.env.PLANE_CTX_CE_API_KEY = "rotated-ce-key";
		const configPath = writeConfig({ contexts: [ce] });

		const resolved = await loadConfig({ configPath });

		expect(resolved.apiKey).toBe("rotated-ce-key");
	});

	test("a MULTI-context config with no default is unaffected by ambient PLANE_*", async () => {
		// It still refuses rather than quietly resolving to the ambient credentials.
		process.env.PLANE_API_KEY = "ambient-cloud-key";
		const configPath = writeConfig({ contexts: [cloud, ce] });
		expect(loadConfig({ configPath })).rejects.toThrow(/multiple contexts/);
	});
});

describe("⚠ replicate never infers an installation", () => {
	test("an implicit context is REFUSED when the caller forbids it", async () => {
		// `replicate --from/--to` are plain options. What made them effectively
		// mandatory was that a multi-context config threw without them; a default
		// would have quietly removed that safety net, so `replicate apply --snapshot
		// x.json` with no `--to` would write an entire project into whichever
		// instance the config preferred. The error names the flag.
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "ce" });
		expect(loadConfig({ configPath, allowImplicitContext: false })).rejects.toThrow(
			/will not infer an installation.*--from\/--to ce/s,
		);
	});

	test("a SINGLE-context config is refused too — one option is still not a choice made", async () => {
		const configPath = writeConfig({ contexts: [ce] });
		expect(loadConfig({ configPath, allowImplicitContext: false })).rejects.toThrow(
			/will not infer an installation/,
		);
	});

	test("an EXPLICIT context is still accepted", async () => {
		const configPath = writeConfig({ contexts: [cloud, ce], defaultContext: "cloud" });
		const resolved = await loadConfig({ configPath, context: "ce", allowImplicitContext: false });
		expect(resolved.apiKey).toBe("ce-key");
	});

	test("a FLAT config still works — bare env is a deliberate choice, not an inference", async () => {
		process.env.PLANE_API_KEY = "flat-key";
		process.env.PLANE_WORKSPACE_SLUG = "flat-ws";
		const configPath = writeConfig({ defaultProject: "P" });
		const resolved = await loadConfig({ configPath, allowImplicitContext: false });
		expect(resolved.apiKey).toBe("flat-key");
	});
});

describe("error messages name the context actually in force", () => {
	test("a missing key on an IMPLICIT context does not advise setting bare PLANE_API_KEY", async () => {
		// That advice cannot work: an implicitly selected context ignores bare
		// PLANE_* by design, so the user would set the variable, re-run, and get the
		// same error with nothing pointing at why.
		const configPath = writeConfig({ contexts: [{ name: "ce", workspaceSlug: "archimedes" }] });
		expect(loadConfig({ configPath })).rejects.toThrow(/PLANE_CTX_CE_API_KEY/);
		expect(loadConfig({ configPath })).rejects.not.toThrow(/Set PLANE_API_KEY in your environment/);
	});
});
