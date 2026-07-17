import { describe, expect, test } from "bun:test";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../src/errors.ts";
import type { UserStory } from "../../src/types.ts";

describe("smoke test", () => {
	test("bun:test works", () => {
		expect(1 + 1).toBe(2);
	});

	test("types are importable", () => {
		const story: UserStory = {
			title: "Test story",
			planeId: null,
			planeIdentifier: null,
			planeUrl: null,
			planeHash: null,
			priority: null,
			labels: [],
			estimate: null,
			assignee: null,
			status: null,
			body: "Test body",
			project: null,
			parent: null,
			kind: null,
		};
		expect(story.title).toBe("Test story");
	});

	test("error classes work correctly", () => {
		const configErr = new ConfigError("bad config");
		expect(configErr).toBeInstanceOf(Error);
		expect(configErr).toBeInstanceOf(ConfigError);
		expect(configErr.name).toBe("ConfigError");
		expect(configErr.message).toBe("bad config");

		const parseErr = new ParseError("bad parse");
		expect(parseErr).toBeInstanceOf(ParseError);
		expect(parseErr.name).toBe("ParseError");

		const apiErr = new PlaneApiError("api failed");
		expect(apiErr).toBeInstanceOf(PlaneApiError);
		expect(apiErr.name).toBe("PlaneApiError");

		const resolverErr = new ResolverError("not found");
		expect(resolverErr).toBeInstanceOf(ResolverError);
		expect(resolverErr.name).toBe("ResolverError");
	});
});
