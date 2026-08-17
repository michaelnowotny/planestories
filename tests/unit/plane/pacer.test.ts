import { describe, expect, test } from "bun:test";
import { Pacer } from "../../../src/plane/pacer.ts";

function fakeTime(): {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	advance: (ms: number) => void;
	current: () => number;
} {
	let time = 0;
	return {
		now: () => time,
		sleep: async (ms) => {
			time += ms;
		},
		advance: (ms) => {
			time += ms;
		},
		current: () => time,
	};
}

function settleLatency(pacer: Pacer, milliseconds: number): void {
	for (let i = 0; i < 100; i++) {
		pacer.recordLatency(milliseconds);
	}
}

describe("Pacer concurrency", () => {
	test.each([
		{ rpm: 60, latency: 150, expected: 1 },
		{ rpm: 600, latency: 150, expected: 2 },
		{ rpm: 600, latency: 1500, expected: 12 },
	])("derives $expected for $rpm/min at $latency ms", ({ rpm, latency, expected }) => {
		const clock = fakeTime();
		const pacer = new Pacer({
			requestsPerMinute: rpm,
			now: clock.now,
			sleep: clock.sleep,
		});
		settleLatency(pacer, latency);
		expect(pacer.concurrency()).toBe(expected);
	});

	test("clamps latency EWMA and derived concurrency", () => {
		const clock = fakeTime();
		const pacer = new Pacer({
			requestsPerMinute: 600,
			maxConcurrency: 7,
			now: clock.now,
			sleep: clock.sleep,
		});
		pacer.recordLatency(30_000);
		expect(pacer.concurrency()).toBe(7);
		expect(pacer.stats().latencyMs).toBeLessThanOrEqual(10_000);

		for (let i = 0; i < 100; i++) {
			pacer.recordLatency(1);
		}
		expect(pacer.stats().latencyMs).toBe(20);
		expect(pacer.concurrency()).toBeGreaterThanOrEqual(1);
	});
});

describe("Pacer token bucket", () => {
	test("admits at the headroom-adjusted configured rate and no faster", async () => {
		const clock = fakeTime();
		const pacer = new Pacer({
			requestsPerMinute: 60,
			now: clock.now,
			sleep: clock.sleep,
		});
		const admissionTimes: number[] = [];
		for (let i = 0; i < 49; i++) {
			await pacer.acquire();
			admissionTimes.push(clock.current());
		}

		// Capacity one permits the initial request; the remaining 48 arrive at
		// 60 / min × 0.8 = 48/min, with the next minute's boundary excluded.
		expect(admissionTimes.filter((time) => time < 60_000)).toHaveLength(48);
		expect(admissionTimes.at(-1)).toBe(60_000);
		for (let i = 2; i < admissionTimes.length; i++) {
			expect((admissionTimes[i] as number) - (admissionTimes[i - 1] as number)).toBe(1250);
		}
	});
});

describe("Pacer throttle adaptation", () => {
	test("halves effective rate, then recovers additively without exceeding the ceiling", () => {
		const clock = fakeTime();
		const pacer = new Pacer({
			requestsPerMinute: 600,
			now: clock.now,
			sleep: clock.sleep,
		});

		expect(pacer.stats().effectiveRpm).toBe(480);
		pacer.recordThrottled();
		expect(pacer.stats()).toMatchObject({ effectiveRpm: 240, throttled: 1 });

		clock.advance(60_000);
		expect(pacer.stats().effectiveRpm).toBe(300);
		clock.advance(3 * 60_000);
		expect(pacer.stats().effectiveRpm).toBe(480);
		clock.advance(10 * 60_000);
		expect(pacer.stats().effectiveRpm).toBe(480);
	});

	test("multiplicative decrease respects the configured-rate floor", () => {
		const clock = fakeTime();
		const pacer = new Pacer({
			requestsPerMinute: 5,
			now: clock.now,
			sleep: clock.sleep,
		});
		for (let i = 0; i < 10; i++) {
			pacer.recordThrottled();
		}
		expect(pacer.stats().effectiveRpm).toBe(1);
	});
});
