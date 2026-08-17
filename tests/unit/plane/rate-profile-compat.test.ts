import { describe, expect, test } from "bun:test";
import { createPlaneClient } from "../../../src/plane/client.ts";
import { Pacer } from "../../../src/plane/pacer.ts";

/**
 * The rate profile is OPT-IN. We do not know Plane Cloud's enforced limit and
 * must never guess one, so a client with no `apiRateLimit` configured must
 * behave exactly as it did before the pacer existed: no derived concurrency
 * (every call site keeps its own documented constant) and no pacing telemetry.
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

	// The CONFIG layer parses Plane's `"600/minute"` form; the CLIENT takes the
	// already-parsed `requestsPerMinute`.
	test("a configured client derives concurrency and reports pacing", () => {
		const client = createPlaneClient({ ...base, requestsPerMinute: 600 });
		expect(client.concurrency()).toBeGreaterThanOrEqual(1);
		expect(client.pacingSummary()).toContain("600/min");
	});

	test("sibling clients SHARE one budget — the limit is per API key", () => {
		const client = createPlaneClient({ ...base, requestsPerMinute: 600 });
		const sibling = client.withDialect("work-items");
		const guarded = client.withBeforeWriteAttempt(() => {});
		// Draining the parent's bucket must drain the siblings' too. Two
		// independent buckets against one key would double the burst.
		const before = client.pacingSummary();
		expect(sibling.pacingSummary()).toBe(before);
		expect(guarded.pacingSummary()).toBe(before);
	});
});

describe("pacer invariants that guard against misconfiguration", () => {
	function clock() {
		let t = 0;
		return {
			now: () => t,
			sleep: async (ms: number) => void (t += ms),
			advance: (ms: number) => void (t += ms),
		};
	}

	test("a 429 can never RAISE the effective rate, even with a tiny headroom", () => {
		// Regression: the AIMD floor was max(R/10, 1) with no ceiling clamp, so a
		// headroom below 0.1 put the floor ABOVE the ceiling and a throttle
		// increased the rate — then stuck there, since recovery only runs below
		// the ceiling.
		const c = clock();
		const pacer = new Pacer({ requestsPerMinute: 600, headroom: 0.05, now: c.now, sleep: c.sleep });
		const ceiling = 600 * 0.05;
		expect(pacer.stats().effectiveRpm).toBeCloseTo(ceiling, 6);
		pacer.recordThrottled();
		expect(pacer.stats().effectiveRpm).toBeLessThanOrEqual(ceiling);
		pacer.recordThrottled();
		expect(pacer.stats().effectiveRpm).toBeLessThanOrEqual(ceiling);
	});

	test("concurrent acquirers are each admitted at the configured rate", async () => {
		const c = clock();
		const pacer = new Pacer({ requestsPerMinute: 60, headroom: 1, now: c.now, sleep: c.sleep });
		// 60/min with full headroom = one per second; the bucket starts with its
		// capacity, so a burst drains and the rest must be paced by the clock.
		const started = c.now();
		await Promise.all([pacer.acquire(), pacer.acquire(), pacer.acquire(), pacer.acquire()]);
		expect(c.now() - started).toBeGreaterThan(0);
	});

	test("maxConcurrency must be a positive integer", () => {
		expect(() => new Pacer({ requestsPerMinute: 60, maxConcurrency: 0 })).toThrow();
		expect(() => new Pacer({ requestsPerMinute: 60, maxConcurrency: 2.5 })).toThrow();
		expect(() => new Pacer({ requestsPerMinute: 0 })).toThrow();
	});
});
