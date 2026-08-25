import { afterEach, describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import { PlaneClient } from "../../../src/plane/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function makeClient(): PlaneClient {
	return new PlaneClient({
		apiKey: "k",
		workspaceSlug: "ws",
		baseUrl: "https://plane.example",
		maxRetries: 0,
		sleep: async () => {},
	});
}

/**
 * Serve a fixed page sequence. `cycle` repeats it for every re-walk, which is
 * what a PERSISTENTLY unstable board looks like — the only way to reach the
 * refusal now that ordinary churn is retried rather than thrown on.
 */
function jsonPages(pages: unknown[], options: { cycle?: boolean } = {}): { urls: string[] } {
	const urls: string[] = [];
	const source = [...pages];
	let index = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		urls.push(String(input));
		const page = options.cycle ? source[index++ % source.length] : source[index++];
		if (page === undefined) {
			throw new Error("pagination test made an unexpected fetch");
		}
		return Response.json(page);
	}) as unknown as typeof fetch;
	return { urls };
}

async function rejectedBy(run: Promise<unknown>): Promise<unknown> {
	try {
		await run;
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to reject");
}

describe("PlaneClient.listAll pagination integrity", () => {
	test("rejects next-page=true without a cursor instead of returning page 1 as complete", async () => {
		const stub = jsonPages([
			{
				results: [{ id: "item-1" }],
				total_count: 2,
				next_page_results: true,
				next_cursor: null,
			},
		]);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain("/projects/project-1/issues/");
		expect((error as Error).message).toContain("next_page_results=true");
		expect((error as Error).message).toContain("next_cursor");
		expect(stub.urls).toHaveLength(1);
	});

	test("accepts a leftover cursor on a TERMINAL page, because real Plane sends one", async () => {
		// Measured against Plane CE 1.4.1: every terminal page carries a
		// `next_cursor` alongside `next_page_results: false`. It means "where you
		// would be if you continued", not "there is more". An earlier version of
		// this file asserted the opposite — it encoded a confident claim that no
		// correct server produces this state — and `board fetch` failed on its
		// FIRST call against a real board while the whole suite stayed green.
		//
		// The flag is authoritative for "should I continue"; the cursor is not.
		const pages = [{ results: [{ id: "a" }], next_page_results: false, next_cursor: "20:100:0" }];
		let calls = 0;
		const restore = globalThis.fetch;
		globalThis.fetch = (async () => {
			const body = pages[calls++] ?? { results: [], next_page_results: false };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const client = makeClient();
			const all = await client.listWorkItems<{ id: string }>("p");
			expect(all).toEqual([{ id: "a" }]);
			// It STOPPED: one request, not a second one chasing the leftover cursor.
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = restore;
		}
	});

	test("deduplicates stable ids across pages in first-seen order", async () => {
		const stub = jsonPages([
			{
				results: [
					{ id: "a", value: 1 },
					{ id: "b", value: 2 },
				],
				total_count: 3,
				next_page_results: true,
				next_cursor: "page-2",
			},
			{
				results: [
					{ value: 2, id: "b" },
					{ id: "c", value: 3 },
				],
				total_count: 3,
				next_page_results: false,
				next_cursor: null,
			},
		]);

		const items = await makeClient().listWorkItems<{ id: string; value: number }>("project-1");

		expect(items).toEqual([
			{ id: "a", value: 1 },
			{ id: "b", value: 2 },
			{ id: "c", value: 3 },
		]);
		expect(stub.urls).toHaveLength(2);
		expect(stub.urls[0]).not.toContain("cursor=");
		expect(stub.urls[1]).toContain("cursor=page-2");
	});

	test("refuses when a duplicate id keeps changing content across full re-walks", async () => {
		const stub = jsonPages(
			[
				{
					results: [{ id: "moving", name: "before" }],
					next_page_results: true,
					next_cursor: "page-2",
				},
				{
					results: [{ id: "moving", name: "after" }],
					next_page_results: false,
					next_cursor: null,
				},
			],
			{ cycle: true },
		);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain('duplicate id "moving"');
		expect((error as Error).message).toMatch(/quieter time/i);
		// Three FULL re-walks were attempted before refusing, not one.
		expect(stub.urls.length).toBeGreaterThan(2);
	});

	test("refuses when the unique count keeps disagreeing with total_count across re-walks", async () => {
		const stub = jsonPages(
			[
				{
					results: [{ id: "only-item" }],
					total_count: 2,
					next_page_results: false,
					next_cursor: null,
				},
			],
			{ cycle: true },
		);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain("returned 1 unique items");
		expect((error as Error).message).toContain("total_count=2");
		expect((error as Error).message).toContain("/projects/project-1/issues/");
		// One page per attempt, three attempts before the refusal.
		expect(stub.urls).toHaveLength(3);
	});

	test("allows an absent total_count without claiming it was checked", async () => {
		const stub = jsonPages([
			{
				results: [{ id: "item-1" }],
				next_page_results: false,
				next_cursor: null,
			},
		]);

		expect(await makeClient().listWorkItems("project-1")).toEqual([{ id: "item-1" }]);
		expect(stub.urls).toHaveLength(1);
	});

	for (const body of ["", "not json"]) {
		test(`rejects a 200 list response with ${body ? "a non-JSON" : "an empty"} body`, async () => {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				return new Response(body, { status: 200 });
			}) as unknown as typeof fetch;

			const error = await rejectedBy(makeClient().listWorkItems("project-1"));

			expect(error).toBeInstanceOf(PlaneApiError);
			expect((error as Error).message).toContain("invalid response envelope");
			expect((error as Error).message).toContain("/projects/project-1/issues/");
			expect(calls).toBe(1);
		});
	}

	test("stops after 100 pages when every response claims another unique cursor", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls > 100) {
				throw new Error("pagination escaped its 100-page bound");
			}
			return Response.json({
				results: [{ id: `item-${calls}` }],
				next_page_results: true,
				next_cursor: `cursor-${calls}`,
			});
		}) as unknown as typeof fetch;

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain("exceeded 100 pages");
		// The cap is a runaway-cursor backstop, but it becomes a product limit for a
		// big board — so the message must name the size AND the way out, or it reads
		// like a bug in planestories rather than a boundary.
		expect((error as Error).message).toContain("10000 items");
		expect((error as Error).message).toContain("PLANESTORIES_MAX_LIST_PAGES");
		expect((error as Error).message).toContain("/projects/project-1/issues/");
		expect(calls).toBe(100);
	});
});

/**
 * Board churn during a walk is ORDINARY, not a fault.
 *
 * The integrity checks are correct about a single attempt and wrong as a
 * verdict: a create or delete during a 27-page, 2m35s walk happens on any active
 * board, and failing the whole command after minutes of work would make
 * `board fetch`, `export`, `doctor` and `snapshot` intermittently unusable.
 *
 * So the walk is retried from page one with the accumulation DISCARDED — never a
 * stitched-together mix of two board states, never a partial read published as
 * complete — and refuses explicitly if the board never settles.
 */
describe("listAll retries a whole walk when the board changes underneath it", () => {
	function serve(responses: object[][]): { calls: () => number; restore: () => void } {
		let call = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			const flat = responses.flat();
			const body = flat[call++] ?? { results: [], next_page_results: false };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		return {
			calls: () => call,
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}

	test("a total_count that moves mid-walk causes a re-walk, and the retry succeeds", async () => {
		// Attempt 1: page 1 says 2, page 2 says 3 -> churn. Attempt 2: consistent.
		const server = serve([
			[
				{ results: [{ id: "a" }], total_count: 2, next_page_results: true, next_cursor: "c1" },
				{ results: [{ id: "b" }], total_count: 3, next_page_results: false },
			],
			[
				{ results: [{ id: "a" }], total_count: 2, next_page_results: true, next_cursor: "c1" },
				{ results: [{ id: "b" }], total_count: 2, next_page_results: false },
			],
		]);
		try {
			const all = await makeClient().listWorkItems<{ id: string }>("p");
			// The SECOND attempt's data, whole — not attempt 1's page 1 stitched to
			// attempt 2's page 2.
			expect(all).toEqual([{ id: "a" }, { id: "b" }]);
			expect(server.calls()).toBe(4);
		} finally {
			server.restore();
		}
	});

	test("a board that never settles REFUSES, and says what to do", async () => {
		const unstable = Array.from({ length: 12 }, (_, i) => [
			{ results: [{ id: "a" }], total_count: 2, next_page_results: true, next_cursor: "c1" },
			{ results: [{ id: "b" }], total_count: 3 + i, next_page_results: false },
		]).flat();
		const server = serve([unstable]);
		try {
			await expect(makeClient().listWorkItems("p")).rejects.toThrow(/quieter time/i);
		} finally {
			server.restore();
		}
	});

	test("a PROTOCOL fault is not retried — only board churn is", async () => {
		// next_page_results=true with no cursor is a broken server, not a busy
		// board. Retrying it would just burn three full walks before failing.
		const server = serve([[{ results: [{ id: "a" }], next_page_results: true }]]);
		try {
			await expect(makeClient().listWorkItems("p")).rejects.toThrow(/next_cursor is absent/);
			expect(server.calls()).toBe(1);
		} finally {
			server.restore();
		}
	});
});
