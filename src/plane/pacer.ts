const DEFAULT_HEADROOM = 0.8;
const DEFAULT_MAX_CONCURRENCY = 16;
const INITIAL_LATENCY_MS = 300;
const EWMA_SAMPLE_WEIGHT = 0.2;
const MIN_LATENCY_MS = 20;
const MAX_LATENCY_MS = 10_000;
const MINUTE_MS = 60_000;

export interface PacerOptions {
	requestsPerMinute: number;
	headroom?: number;
	maxConcurrency?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface PacerStats {
	effectiveRpm: number;
	latencyMs: number;
	concurrency: number;
	throttled: number;
}

/**
 * Per-client request pacer. The configured rate remains the throughput
 * authority; concurrency is only the number of in-flight requests needed to
 * saturate that rate at the currently observed latency.
 */
export class Pacer {
	private readonly requestsPerMinute: number;
	private readonly headroom: number;
	private readonly maxConcurrency: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private effectiveRpm: number;
	private latencyMs = INITIAL_LATENCY_MS;
	private throttledCount = 0;
	private tokens: number;
	private lastRefillAt: number;
	private lastRecoveryAt: number;

	constructor(options: PacerOptions) {
		if (!Number.isFinite(options.requestsPerMinute) || options.requestsPerMinute <= 0) {
			throw new RangeError("requestsPerMinute must be positive");
		}
		if (
			options.headroom !== undefined &&
			(!Number.isFinite(options.headroom) || options.headroom <= 0 || options.headroom > 1)
		) {
			throw new RangeError("headroom must be in (0, 1]");
		}
		if (
			options.maxConcurrency !== undefined &&
			(!Number.isInteger(options.maxConcurrency) || options.maxConcurrency <= 0)
		) {
			throw new RangeError("maxConcurrency must be a positive integer");
		}

		this.requestsPerMinute = options.requestsPerMinute;
		this.headroom = options.headroom ?? DEFAULT_HEADROOM;
		this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		this.now = options.now ?? (() => performance.now());
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.effectiveRpm = this.configuredCeiling();
		this.tokens = this.bucketCapacity();
		this.lastRefillAt = this.now();
		this.lastRecoveryAt = this.lastRefillAt;
	}

	/** Wait until the token bucket permits one more HTTP attempt. */
	async acquire(): Promise<void> {
		while (true) {
			this.advance(this.now());
			if (this.tokens >= 1) {
				this.tokens -= 1;
				return;
			}

			const millisecondsPerToken = MINUTE_MS / this.effectiveRpm;
			await this.sleep((1 - this.tokens) * millisecondsPerToken);
		}
	}

	/** Feed a completed request's latency into the bounded EWMA. */
	recordLatency(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) {
			return;
		}
		const next = EWMA_SAMPLE_WEIGHT * ms + (1 - EWMA_SAMPLE_WEIGHT) * this.latencyMs;
		this.latencyMs = Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, next));
	}

	/** Apply multiplicative decrease after a rate-limit response. */
	recordThrottled(): void {
		const currentTime = this.now();
		this.advance(currentTime);
		const floor = Math.max(this.requestsPerMinute / 10, 1);
		this.effectiveRpm = Math.max(floor, this.effectiveRpm / 2);
		this.tokens = Math.min(this.tokens, this.bucketCapacity());
		this.lastRecoveryAt = currentTime;
		this.throttledCount++;
	}

	/** Derived in-flight count from Little's Law, recomputed from current observations. */
	concurrency(): number {
		this.advance(this.now());
		const targetRequestsPerSecond = this.effectiveRpm / 60;
		// Round upward: a fractional additional request is still required to
		// saturate the configured rate (and matches the specification's 8/s ×
		// 150 ms = 2 worked example).
		const derived = Math.ceil(targetRequestsPerSecond * (this.latencyMs / 1000));
		return Math.min(this.maxConcurrency, Math.max(1, derived));
	}

	stats(): PacerStats {
		this.advance(this.now());
		return {
			effectiveRpm: this.effectiveRpm,
			latencyMs: this.latencyMs,
			concurrency: this.concurrency(),
			throttled: this.throttledCount,
		};
	}

	private configuredCeiling(): number {
		return this.requestsPerMinute * this.headroom;
	}

	private bucketCapacity(): number {
		return Math.max(1, Math.ceil(this.effectiveRpm / 60));
	}

	/** Refill tokens and apply additive recovery through the supplied instant. */
	private advance(currentTime: number): void {
		const refillElapsed = Math.max(0, currentTime - this.lastRefillAt);
		this.tokens = Math.min(
			this.bucketCapacity(),
			this.tokens + (refillElapsed * this.effectiveRpm) / MINUTE_MS,
		);
		this.lastRefillAt = Math.max(this.lastRefillAt, currentTime);

		const recoveryMinutes = Math.floor(Math.max(0, currentTime - this.lastRecoveryAt) / MINUTE_MS);
		if (recoveryMinutes > 0 && this.effectiveRpm < this.configuredCeiling()) {
			this.effectiveRpm = Math.min(
				this.configuredCeiling(),
				this.effectiveRpm + recoveryMinutes * this.requestsPerMinute * 0.1,
			);
			this.lastRecoveryAt += recoveryMinutes * MINUTE_MS;
			this.tokens = Math.min(this.tokens, this.bucketCapacity());
		}
	}
}
