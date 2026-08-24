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

function jsonPages(pages: unknown[]): { urls: string[] } {
	const urls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		urls.push(String(input));
		const page = pages.shift();
		if (page === undefined) {
			throw new Error("pagination test made an unexpected fetch");
		}
		return Response.json(page);
	}) as typeof fetch;
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

	test("rejects next-page=false with a cursor as contradictory metadata", async () => {
		const stub = jsonPages([
			{
				results: [{ id: "item-1" }],
				next_page_results: false,
				next_cursor: "unexpected-cursor",
			},
		]);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain("next_page_results=false");
		expect((error as Error).message).toContain("next_cursor");
		expect(stub.urls).toHaveLength(1);
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

	test("rejects a duplicate id whose content changed during the walk", async () => {
		const stub = jsonPages([
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
		]);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain('duplicate id "moving"');
		expect((error as Error).message).toContain("changed content");
		expect(stub.urls).toHaveLength(2);
	});

	test("rejects a completed walk whose unique result count differs from total_count", async () => {
		const stub = jsonPages([
			{
				results: [{ id: "only-item" }],
				total_count: 2,
				next_page_results: false,
				next_cursor: null,
			},
		]);

		const error = await rejectedBy(makeClient().listWorkItems("project-1"));

		expect(error).toBeInstanceOf(PlaneApiError);
		expect((error as Error).message).toContain("returned 1 unique items");
		expect((error as Error).message).toContain("total_count=2");
		expect((error as Error).message).toContain("/projects/project-1/issues/");
		expect(stub.urls).toHaveLength(1);
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
		expect((error as Error).message).toContain("maximum of 100 pages");
		expect((error as Error).message).toContain("/projects/project-1/issues/");
		expect(calls).toBe(100);
	});
});
