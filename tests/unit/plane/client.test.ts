import { afterEach, describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import { deriveWebBaseUrl, PlaneClient } from "../../../src/plane/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function stubFetch(status: number, body?: unknown): void {
	globalThis.fetch = (async () =>
		new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

const client = new PlaneClient({ apiKey: "k", workspaceSlug: "ws" });

describe("PlaneClient.findWorkItemByExternalId", () => {
	// Regression: Plane returns 404 (not an empty list) when no work item matches
	// the external_id. The lookup must resolve to null rather than throwing.
	test("returns null on a 404 (no match)", async () => {
		stubFetch(404, { error: "The requested resource does not exist." });
		const result = await client.findWorkItemByExternalId("p", "missing", "planestories");
		expect(result).toBeNull();
	});

	test("returns the work item object on a 200 (match)", async () => {
		stubFetch(200, { id: "wi-1", sequence_id: 5 });
		const result = await client.findWorkItemByExternalId("p", "found", "planestories");
		expect(result).toEqual({ id: "wi-1", sequence_id: 5 });
	});

	test("still throws on non-404 errors", async () => {
		stubFetch(500, { error: "boom" });
		expect(client.findWorkItemByExternalId("p", "x", "planestories")).rejects.toThrow(
			PlaneApiError,
		);
	});
});

describe("PlaneClient.request", () => {
	test("throws PlaneApiError on a 404 by default (no allowNotFound)", async () => {
		stubFetch(404, { error: "nope" });
		expect(client.listProjects()).rejects.toThrow(PlaneApiError);
	});
});

describe("deriveWebBaseUrl", () => {
	test("maps Plane Cloud api host to the app host", () => {
		expect(deriveWebBaseUrl("https://api.plane.so")).toBe("https://app.plane.so");
	});

	test("uses the instance origin for self-hosted base urls", () => {
		expect(deriveWebBaseUrl("https://plane.example.com")).toBe("https://plane.example.com");
	});
});
