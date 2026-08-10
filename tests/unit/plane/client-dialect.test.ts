import { afterEach, describe, expect, test } from "bun:test";
import { PlaneClient } from "../../../src/plane/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Install a fetch stub that records every requested URL and returns `body`. */
function captureFetch(body: unknown = {}, status = 200): { urls: string[]; methods: string[] } {
	const urls: string[] = [];
	const methods: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		urls.push(String(input));
		methods.push(init?.method ?? "GET");
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { urls, methods };
}

function makeClient(dialect?: "issues" | "work-items"): PlaneClient {
	return new PlaneClient({
		apiKey: "k",
		workspaceSlug: "ws",
		maxRetries: 0,
		sleep: async () => {},
		dialect,
	});
}

describe("endpoint dialect", () => {
	test("defaults to the /issues/ path family", async () => {
		const captured = captureFetch({ id: "i1", sequence_id: 1 });
		await makeClient().createWorkItem("p1", { name: "x" });
		expect(captured.urls[0]).toContain("/projects/p1/issues/");
		expect(captured.urls[0]).not.toContain("work-items");
	});

	test("work-items dialect swaps the segment on every item path", async () => {
		const client = makeClient("work-items");
		const captured = captureFetch({ results: [], next_page_results: false });
		await client.listWorkItems("p1");
		await client.getWorkItem("p1", "i1");
		await client.getRelations("p1", "i1");
		await client.listWorkItemComments("p1", "i1");
		await client.deleteWorkItem("p1", "i1");
		for (const url of captured.urls) {
			expect(url).toContain("/projects/p1/work-items/");
			expect(url).not.toContain("/issues/");
		}
	});

	test("dialect does not leak into non-item paths (states, labels, projects)", async () => {
		const client = makeClient("work-items");
		const captured = captureFetch({ results: [], next_page_results: false });
		await client.listStates("p1");
		await client.listLabels("p1");
		await client.listProjects();
		for (const url of captured.urls) {
			expect(url).not.toContain("work-items");
		}
	});
});

describe("replication endpoints", () => {
	test("project lifecycle paths and methods", async () => {
		const client = makeClient();
		const captured = captureFetch({ id: "p9" });
		await client.createProject({ name: "N", identifier: "N9" });
		await client.getProject("p9");
		await client.updateProject("p9", { name: "M" });
		await client.deleteProject("p9");
		expect(captured.urls[0]).toContain("/api/v1/workspaces/ws/projects/");
		expect(captured.methods).toEqual(["POST", "GET", "PATCH", "DELETE"]);
		expect(captured.urls[3]).toContain("/projects/p9/");
	});

	test("state create/update and label update paths", async () => {
		const client = makeClient();
		const captured = captureFetch({ id: "s1" });
		await client.createState("p1", { name: "Done", group: "completed" });
		await client.updateState("p1", "s1", { color: "#fff" });
		await client.updateLabel("p1", "l1", { color: "#000" });
		expect(captured.urls[0]).toContain("/projects/p1/states/");
		expect(captured.urls[1]).toContain("/projects/p1/states/s1/");
		expect(captured.urls[2]).toContain("/projects/p1/labels/l1/");
	});

	test("archived list resolves null on 404 (endpoint unavailable)", async () => {
		const client = makeClient();
		captureFetch({}, 404);
		const result = await client.listArchivedWorkItems("p1");
		expect(result).toBeNull();
	});

	test("archived list paginates the dialect-specific archived path when available", async () => {
		const client = makeClient("work-items");
		const captured = captureFetch({ results: [{ id: "a1" }], next_page_results: false });
		const result = await client.listArchivedWorkItems("p1");
		expect(result).toEqual([{ id: "a1" }]);
		expect(captured.urls[0]).toContain("/projects/p1/archived-work-items/");
	});

	test("archive/unarchive verbs hit the item archive path", async () => {
		const client = makeClient();
		const captured = captureFetch(undefined);
		await client.archiveWorkItem("p1", "i1");
		await client.unarchiveWorkItem("p1", "i1");
		expect(captured.urls[0]).toContain("/projects/p1/issues/i1/archive/");
		expect(captured.methods).toEqual(["POST", "DELETE"]);
	});

	test("createWorkItem honors a per-call maxRetries of 0 (A10 discipline)", async () => {
		// Client default allows retries; the per-call override must win so an
		// ambiguous create is NEVER blindly replayed.
		const client = new PlaneClient({
			apiKey: "k",
			workspaceSlug: "ws",
			maxRetries: 5,
			retryBaseDelayMs: 1,
			sleep: async () => {},
		});
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("{}", { status: 503 });
		}) as unknown as typeof fetch;
		await expect(client.createWorkItem("p1", { name: "x" }, { maxRetries: 0 })).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
