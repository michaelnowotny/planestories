import { afterEach, describe, expect, test } from "bun:test";
import { connectTarget } from "../../../src/cli/target_client.ts";
import { DialectResolver } from "../../../src/plane/dialect.ts";
import type { ResolvedConfig } from "../../../src/types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function config(baseUrl: string, dialect?: "issues" | "work-items"): ResolvedConfig {
	return {
		apiKey: "k",
		workspaceSlug: "ws",
		baseUrl,
		dialect,
		defaultProject: "Data Platform",
		defaultLabels: [],
		sourceLabel: null,
		maxRetries: 0,
		contextName: "ce",
	};
}

const EMPTY_RELATIONS = {
	blocking: [],
	blocked_by: [],
	relates_to: [],
	duplicate: [],
	start_before: [],
	start_after: [],
	finish_before: [],
	finish_after: [],
};

describe("live target connection", () => {
	test("configured dialect wins without any detection request", async () => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			throw new Error("must not fetch");
		}) as unknown as typeof fetch;
		const target = await connectTarget(config("https://configured.example", "work-items"), {
			resolver: new DialectResolver(),
		});
		expect(target.client.dialect).toBe("work-items");
		expect(target.config.dialectSource).toBe("configured");
		expect(fetches).toBe(0);
	});

	test("absent dialect uses one bounded sample and caches the relation verdict", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/projects/?")) {
				return Response.json({
					results: [{ id: "project-1", name: "Data Platform", identifier: "DATA" }],
					next_page_results: false,
				});
			}
			if (url.includes("/issues/item-1/relations/")) {
				return Response.json({ error: "Page not found." }, { status: 404 });
			}
			if (url.includes("/work-items/item-1/relations/")) {
				return Response.json(EMPTY_RELATIONS);
			}
			if (url.includes("/projects/project-1/issues/")) {
				return Response.json({ results: [{ id: "item-1" }], next_page_results: false });
			}
			throw new Error(`unexpected URL ${url}`);
		}) as typeof fetch;
		const resolver = new DialectResolver();
		const loaded = config("https://detected.example");

		const first = await connectTarget(loaded, { resolver });
		const second = await connectTarget(loaded, { resolver });
		expect(first.client.dialect).toBe("work-items");
		expect(first.config.dialectSource).toBe("detected");
		expect(second.client.dialect).toBe("work-items");
		expect(urls.filter((url) => new URL(url).searchParams.get("per_page") === "1")).toHaveLength(1);
		expect(urls).toHaveLength(4);
	});

	test("detection failure falls back loudly without becoming fatal", async () => {
		globalThis.fetch = (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch;
		const warnings: string[] = [];
		const target = await connectTarget(config("https://fallback.example"), {
			resolver: new DialectResolver(),
			warn: (message) => warnings.push(message),
		});
		expect(target.client.dialect).toBe("issues");
		expect(target.config.dialectSource).toBe("fallback");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Falling back");
	});
});
