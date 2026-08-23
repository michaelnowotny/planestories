import { afterEach, describe, expect, test } from "bun:test";
import { PlaneClient } from "../../../src/plane/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("read-only capability probe endpoints", () => {
	test("all helpers issue GET requests to their documented paths", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, method: init?.method ?? "GET" });
			if (url.endsWith("/api/instances/")) {
				return Response.json({ instance: { edition: "PLANE_CLOUD", current_version: "2.6.0" } });
			}
			if (url.includes("/projects/project-1/issues/") && !url.includes("pql=")) {
				return Response.json({ results: [{ id: "item-1" }], next_page_results: false });
			}
			return Response.json({ total_count: 1, results: [] });
		}) as typeof fetch;
		const client = new PlaneClient({
			apiKey: "k",
			workspaceSlug: "ws",
			baseUrl: "https://plane.example",
			maxRetries: 0,
		});

		await client.getInstance();
		await client.sampleWorkItem("project-1");
		await client.probePql("project-1");
		await client.probeWorkspaceCount();

		expect(requests.every((request) => request.method === "GET")).toBeTrue();
		expect(requests[0]?.url).toBe("https://plane.example/api/instances/");
		expect(requests[1]?.url).toContain("/projects/project-1/issues/");
		expect(requests[1]?.url).toContain("per_page=1");
		expect(requests[2]?.url).toContain("pql=");
		expect(requests[3]?.url).toContain("/api/v1/workspaces/ws/work-items/count/");
	});
});
