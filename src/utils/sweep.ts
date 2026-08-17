import { mapWithConcurrency } from "./concurrency.ts";

export interface SweepResult<T, R> {
	/** Input-ordered successful results. */
	results: Array<{ item: T; value: R }>;
	/** Items whose fetch still failed after the sequential second pass. */
	failures: Array<{ item: T; error: unknown }>;
	/** Items recovered by the second pass (for reporting). */
	recovered: number;
}

/**
 * Generic two-phase paced fetch tuned for Plane's rate limits (the same shape
 * the atlas relation sweep proved out). Phase 1 runs at modest concurrency;
 * any item whose fetch fails — typically a 429 that outlived the client's own
 * Retry-After backoff — is retried in phase 2 SEQUENTIALLY, one request at a
 * time, letting the client's backoff pace the stream. Results are returned in
 * INPUT order regardless of recovery timing, so artifacts built from them stay
 * diff-stable. Callers decide what residual failures mean; replication treats
 * ANY failure as fatal (a snapshot must never be "mostly complete").
 */
export async function sweepFetch<T, R>(
	items: readonly T[],
	fn: (item: T) => Promise<R>,
	concurrency: number,
): Promise<SweepResult<T, R>> {
	const firstPass = await mapWithConcurrency([...items], concurrency, async (item) => {
		try {
			return { ok: true as const, value: await fn(item) };
		} catch (error) {
			return { ok: false as const, error };
		}
	});

	let recovered = 0;
	const failures: Array<{ item: T; error: unknown }> = [];
	const values = new Map<number, R>();
	for (let i = 0; i < items.length; i++) {
		const first = firstPass[i];
		if (first?.ok) {
			values.set(i, first.value);
			continue;
		}
		try {
			values.set(i, await fn(items[i] as T));
			recovered++;
		} catch (error) {
			failures.push({ item: items[i] as T, error });
		}
	}

	const results: Array<{ item: T; value: R }> = [];
	for (let i = 0; i < items.length; i++) {
		if (values.has(i)) {
			results.push({ item: items[i] as T, value: values.get(i) as R });
		}
	}
	return { results, failures, recovered };
}
