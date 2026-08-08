import { afterEach, describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import {
	deriveWebBaseUrl,
	PlaneClient,
	type PlaneClientOptions,
} from "../../../src/plane/client.ts";

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

function makeResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * Install a fetch stub that walks a list of response makers, one per call.
 * A maker that throws simulates a network-level failure. Once the list is
 * exhausted the last maker repeats (useful for "always 429"). Returns a
 * mutable object whose `calls` counts how many times fetch was invoked.
 */
function queueFetch(makers: Array<() => Response>): { calls: number } {
	const state = { calls: 0 };
	globalThis.fetch = (async () => {
		const maker = makers[Math.min(state.calls, makers.length - 1)];
		state.calls++;
		if (!maker) {
			throw new Error("queueFetch: no response maker available");
		}
		return maker();
	}) as unknown as typeof fetch;
	return state;
}

/** A client whose sleep is a no-op that records the requested delays. */
function clientWithCapturedSleep(opts: Partial<PlaneClientOptions> = {}): {
	client: PlaneClient;
	delays: number[];
} {
	const delays: number[] = [];
	const client = new PlaneClient({
		apiKey: "k",
		workspaceSlug: "ws",
		retryBaseDelayMs: 10,
		sleep: async (ms) => {
			delays.push(ms);
		},
		...opts,
	});
	return { client, delays };
}

// Shared client for the non-retry behavioral tests. Retries are disabled and
// sleep is a no-op so these assertions stay instant and test only the terminal
// success/error mapping.
const client = new PlaneClient({
	apiKey: "k",
	workspaceSlug: "ws",
	maxRetries: 0,
	sleep: async () => {},
});

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

describe("PlaneClient relation endpoints", () => {
	test("uses the verified relation and relations/remove paths", async () => {
		const requests: Array<{ method: string; url: string; body?: string }> = [];
		globalThis.fetch = (async (input, init) => {
			requests.push({
				method: init?.method ?? "GET",
				url: String(input),
				body: init?.body as string | undefined,
			});
			if (init?.method === "GET") {
				return new Response(
					JSON.stringify({
						blocking: [],
						blocked_by: ["other"],
						relates_to: [],
						duplicate: [],
						start_before: [],
						start_after: [],
						finish_before: [],
						finish_after: [],
					}),
					{ status: 200 },
				);
			}
			return new Response(null, { status: 204 });
		}) as typeof fetch;

		expect((await client.getRelations("p", "a")).blocked_by).toEqual(["other"]);
		await client.createRelation("p", "a", "blocked_by", ["other"]);
		await client.removeRelation("p", "a", "blocked_by", "other");

		expect(requests[0]?.url).toEndWith("/projects/p/issues/a/relations/");
		expect(requests[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ relation_type: "blocked_by", issues: ["other"] }),
		});
		expect(requests[2]?.url).toEndWith("/projects/p/issues/a/relations/remove/");
		expect(requests[2]?.body).toBe(
			JSON.stringify({ relation_type: "blocked_by", related_issue: "other" }),
		);
	});
});

describe("PlaneClient.request", () => {
	test("throws PlaneApiError on a 404 by default (no allowNotFound)", async () => {
		stubFetch(404, { error: "nope" });
		expect(client.listProjects()).rejects.toThrow(PlaneApiError);
	});
});

describe("PlaneClient.request retry/backoff", () => {
	test("retries a 429 then succeeds, honoring Retry-After (seconds)", async () => {
		const { client, delays } = clientWithCapturedSleep();
		const state = queueFetch([
			() => makeResponse(429, { error: "slow down" }, { "retry-after": "2" }),
			() => makeResponse(200, { id: "wi-1" }),
		]);
		const result = await client.request("GET", "/x");
		expect(result).toEqual({ id: "wi-1" });
		expect(state.calls).toBe(2);
		expect(delays).toEqual([2000]);
	});

	test("retries a 5xx then succeeds", async () => {
		const { client } = clientWithCapturedSleep();
		const state = queueFetch([() => makeResponse(503), () => makeResponse(200, { ok: true })]);
		const result = await client.request("GET", "/x");
		expect(result).toEqual({ ok: true });
		expect(state.calls).toBe(2);
	});

	test("retries a network error then succeeds", async () => {
		const { client } = clientWithCapturedSleep();
		const state = queueFetch([
			(): Response => {
				throw new Error("ECONNRESET");
			},
			() => makeResponse(200, { ok: true }),
		]);
		const result = await client.request("GET", "/x");
		expect(result).toEqual({ ok: true });
		expect(state.calls).toBe(2);
	});

	test("throws after exhausting the retry budget on a persistent 429", async () => {
		const { client, delays } = clientWithCapturedSleep({ maxRetries: 2 });
		const state = queueFetch([() => makeResponse(429, { error: "nope" })]);
		expect(client.request("GET", "/x")).rejects.toThrow(PlaneApiError);
		// Let the rejected promise settle before asserting call counts.
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(state.calls).toBe(3); // 1 initial + 2 retries
		expect(delays.length).toBe(2);
	});

	test("does not retry a non-retryable 4xx", async () => {
		const { client } = clientWithCapturedSleep();
		const state = queueFetch([() => makeResponse(400, { error: "bad request" })]);
		expect(client.request("POST", "/x")).rejects.toThrow(PlaneApiError);
		await new Promise((r) => setTimeout(r, 0));
		expect(state.calls).toBe(1);
	});

	test("maxRetries=0 disables retries entirely", async () => {
		const { client } = clientWithCapturedSleep({ maxRetries: 0 });
		const state = queueFetch([() => makeResponse(429)]);
		expect(client.request("GET", "/x")).rejects.toThrow(PlaneApiError);
		await new Promise((r) => setTimeout(r, 0));
		expect(state.calls).toBe(1);
	});

	test("uses exponential backoff with jitter when there is no Retry-After", async () => {
		const { client, delays } = clientWithCapturedSleep({ maxRetries: 2, retryBaseDelayMs: 100 });
		queueFetch([
			() => makeResponse(429),
			() => makeResponse(429),
			() => makeResponse(200, { ok: true }),
		]);
		await client.request("GET", "/x");
		expect(delays.length).toBe(2);
		// attempt 1: base*2^0 = 100, + jitter in [0,100) => [100, 200)
		expect(delays[0]).toBeGreaterThanOrEqual(100);
		expect(delays[0]).toBeLessThan(200);
		// attempt 2: base*2^1 = 200, + jitter in [0,100) => [200, 300)
		expect(delays[1]).toBeGreaterThanOrEqual(200);
		expect(delays[1]).toBeLessThan(300);
	});

	test("clamps a huge Retry-After to maxRetryDelayMs", async () => {
		const { client, delays } = clientWithCapturedSleep({ maxRetryDelayMs: 5000 });
		queueFetch([
			() => makeResponse(429, undefined, { "retry-after": "9999" }),
			() => makeResponse(200, { ok: true }),
		]);
		await client.request("GET", "/x");
		expect(delays).toEqual([5000]);
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

describe("per-call retry override (non-idempotent writes)", () => {
	// A POST that is NOT safe to blindly replay (comment create) passes
	// maxRetries: 0 per-call: the client must surface the transient failure
	// immediately (exactly one fetch), letting the caller verify-then-retry.
	test("maxRetries: 0 on the call disables retries even when the client allows them", async () => {
		const { client: c } = clientWithCapturedSleep({ maxRetries: 5 });
		const state = queueFetch([() => makeResponse(503), () => makeResponse(200, { ok: true })]);
		await expect(
			c.request("POST", "/api/v1/workspaces/ws/x/", { body: {}, maxRetries: 0 }),
		).rejects.toThrow("503");
		expect(state.calls).toBe(1);
	});

	test("PlaneApiError carries the HTTP status for caller-side classification", async () => {
		const { client: c } = clientWithCapturedSleep({ maxRetries: 0 });
		queueFetch([() => makeResponse(400, { error: "bad" })]);
		try {
			await c.request("POST", "/api/v1/workspaces/ws/x/", { body: {} });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(PlaneApiError);
			expect((err as PlaneApiError).status).toBe(400);
		}
	});
});
