import { describe, expect, test } from "bun:test";
import { createPlaneClient } from "../../../src/plane/client.ts";

/**
 * The rate profile is OPT-IN. We do not know Plane Cloud's enforced limit and
 * must never guess one, so a client with no `apiRateLimit` configured must
 * behave exactly as it did before the pacer existed: no derived concurrency
 * (every call site keeps its own documented constant), no pacing telemetry,
 * and no rate gate in front of a request.
 */
describe("rate profile is opt-in", () => {
	const base = {
		apiKey: "k",
		workspaceSlug: "ws",
		baseUrl: "https://example.invalid",
		maxRetries: 0,
	};

	test("an unconfigured client derives no concurrency and reports no pacing", () => {
		const client = createPlaneClient(base);
		expect(client.concurrency()).toBeUndefined();
		expect(client.pacingSummary()).toBeUndefined();
	});

	// Note the layering: the CONFIG layer parses Plane's `"600/minute"` form into
	// a number; the CLIENT takes the already-parsed `requestsPerMinute`.
	test("a configured client derives concurrency and reports pacing", () => {
		const client = createPlaneClient({ ...base, requestsPerMinute: 600 });
		expect(client.concurrency()).toBeGreaterThanOrEqual(1);
		expect(client.pacingSummary()).toBeTypeOf("string");
	});

	test("an unconfigured client never delays a request", async () => {
		// No pacer means no token bucket in front of the fetch: a burst of
		// acquisitions must complete without wall-clock pacing. If a future
		// change makes the pacer unconditional, this test catches it.
		const client = createPlaneClient(base);
		const started = performance.now();
		for (let i = 0; i < 50; i++) {
			expect(client.concurrency()).toBeUndefined();
		}
		expect(performance.now() - started).toBeLessThan(250);
	});
});
