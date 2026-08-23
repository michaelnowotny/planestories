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
		await client.listWorkItemActivities("p1", "i1");
		await client.deleteWorkItem("p1", "i1");
		for (const url of captured.urls) {
			expect(url).toContain("/projects/p1/work-items/");
			expect(url).not.toContain("/issues/");
		}
	});

	test("current-user lookup is instance-level and independent of item dialect", async () => {
		const client = makeClient("work-items");
		const captured = captureFetch({ id: "user-1" });

		expect(await client.getCurrentUser<{ id: string }>()).toEqual({ id: "user-1" });
		expect(captured.urls).toEqual(["https://api.plane.so/api/v1/users/me/"]);
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

	test("beforeWriteAttempt runs before EVERY write attempt, including internal retries", async () => {
		// A caller-side guard sees only the method call; the retry loop's later
		// attempts happen after backoff sleeps it cannot observe. The hook must
		// run per HTTP attempt, and a hook throw must abort with no further
		// fetches — this is what lets a lost journal lock stop mid-retry writes.
		const calls: number[] = [];
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			return new Response("{}", {
				status: fetches < 3 ? 503 : 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const base = new PlaneClient({
			apiKey: "k",
			workspaceSlug: "ws",
			maxRetries: 5,
			retryBaseDelayMs: 1,
			sleep: async () => {},
		});
		const hooked = base.withBeforeWriteAttempt(() => calls.push(fetches));
		await hooked.createWorkItem("p1", { name: "x" });
		expect(fetches).toBe(3);
		expect(calls).toEqual([0, 1, 2]); // before attempts 1, 2 AND 3

		// GET requests are not write-guarded.
		calls.length = 0;
		fetches = 0;
		globalThis.fetch = (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		await hooked.getWorkItem("p1", "i1");
		expect(calls).toEqual([]);

		// A hook throw aborts the retry loop immediately: attempt 1 fails 503,
		// the hook throws before attempt 2 — no second fetch happens.
		fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			return new Response("{}", { status: 503 });
		}) as unknown as typeof fetch;
		let armed = false;
		const tripwire = base.withBeforeWriteAttempt(() => {
			if (armed) throw new Error("lock lost");
			armed = true;
		});
		await expect(tripwire.createWorkItem("p1", { name: "x" })).rejects.toThrow("lock lost");
		expect(fetches).toBe(1);
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
