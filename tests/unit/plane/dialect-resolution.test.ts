import { describe, expect, test } from "bun:test";
import { DialectResolver } from "../../../src/plane/dialect.ts";
import type { ResolvedConfig } from "../../../src/types.ts";

function config(dialect?: "issues" | "work-items"): ResolvedConfig {
	return {
		apiKey: "k",
		workspaceSlug: "ws",
		baseUrl: "https://plane.example",
		dialect,
		defaultProject: null,
		defaultLabels: [],
		sourceLabel: null,
		maxRetries: 0,
		contextName: "ce",
	};
}

describe("runtime dialect resolution", () => {
	test("an explicitly configured dialect always wins without probing", async () => {
		let probes = 0;
		const resolver = new DialectResolver();
		const result = await resolver.resolve(config("work-items"), async () => {
			probes++;
			return { dialect: "issues", source: "detected" };
		});

		expect(result).toEqual({ dialect: "work-items", source: "configured" });
		expect(probes).toBe(0);
	});

	test("an explicit dialect also wins over a cached detection", async () => {
		let probes = 0;
		const resolver = new DialectResolver();
		await resolver.resolve(config(), async () => {
			probes++;
			return { dialect: "issues", source: "detected" };
		});
		const result = await resolver.resolve(config("work-items"), async () => {
			probes++;
			return { dialect: "issues", source: "detected" };
		});

		expect(result).toEqual({ dialect: "work-items", source: "configured" });
		expect(probes).toBe(1);
	});

	test("an absent dialect is detected once and cached per context", async () => {
		let probes = 0;
		const resolver = new DialectResolver();
		const detect = async () => {
			probes++;
			return { dialect: "work-items" as const, source: "detected" as const };
		};

		expect(await resolver.resolve(config(), detect)).toEqual({
			dialect: "work-items",
			source: "detected",
		});
		expect(await resolver.resolve(config(), detect)).toEqual({
			dialect: "work-items",
			source: "detected",
		});
		expect(probes).toBe(1);
	});

	test("an already-detected dialect keeps its provenance without probing again", async () => {
		let probes = 0;
		const resolver = new DialectResolver();
		const result = await resolver.resolve(
			{ ...config("work-items"), dialectSource: "detected" },
			async () => {
				probes++;
				return { dialect: "issues", source: "detected" };
			},
		);

		expect(result).toEqual({ dialect: "work-items", source: "detected" });
		expect(probes).toBe(0);
	});

	test("a failed detector falls back to issues and retains a loud reason", async () => {
		const resolver = new DialectResolver();
		const result = await resolver.resolve(config(), async () => {
			throw new Error("instance unreachable");
		});

		expect(result.dialect).toBe("issues");
		expect(result.source).toBe("fallback");
		expect(result.reason).toContain("instance unreachable");
	});

	test("different contexts are cached independently", async () => {
		let probes = 0;
		const resolver = new DialectResolver();
		const detect = async () => {
			probes++;
			return { dialect: "issues" as const, source: "detected" as const };
		};
		await resolver.resolve(config(), detect);
		await resolver.resolve({ ...config(), contextName: "cloud" }, detect);
		expect(probes).toBe(2);
	});
});
