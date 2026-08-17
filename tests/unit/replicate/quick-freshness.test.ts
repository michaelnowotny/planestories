import { describe, expect, test } from "bun:test";
import { checkFreshnessQuick } from "../../../src/replicate/freshness.ts";
import { sampleSnapshot } from "./fixtures.ts";

/**
 * The cheap check exists because a full enumeration is unaffordable against a
 * rate-limited instance — during a real cutover no freshness verdict could be
 * obtained at all. It must therefore work on a REAL board, which has archived items.
 */
describe("freshness --quick", () => {
	const snapshot = sampleSnapshot();
	const live = snapshot.items.filter((item) => !item.archived);
	const liveMax = live.reduce((max, item) => Math.max(max, item.sequenceId), 0);

	function client(totalCount: number, maxSequenceId: number | null) {
		return {
			dialect: snapshot.source.dialect,
			listWorkItems: async () => [],
			listArchivedWorkItems: async () => null,
			listWorkItemComments: async () => [],
			getRelations: async () => ({}) as never,
			workItemCensus: async () => ({ totalCount, maxSequenceId }),
		} as never;
	}

	test("an unchanged board reads FRESH even though it has archived items", async () => {
		// Regression: comparing the live census against snapshot.items (live + archived)
		// reported CHANGED on every real board, making the cheap signal useless exactly
		// where it was needed.
		expect(snapshot.items.some((item) => item.archived)).toBe(true);
		const report = await checkFreshnessQuick(client(live.length, liveMax), snapshot);
		expect(report.fresh).toBe(true);
	});

	test("an added item reads CHANGED", async () => {
		const report = await checkFreshnessQuick(client(live.length + 1, liveMax + 1), snapshot);
		expect(report.fresh).toBe(false);
	});

	test("it states its own blindness, including the archived caveat", async () => {
		const report = await checkFreshnessQuick(client(live.length, liveMax), snapshot);
		const notes = report.notes.join(" ");
		expect(notes).toMatch(/CANNOT see edits/i);
		expect(notes).toMatch(/ARCHIVED/i);
	});

	test("an instance that returns no usable count fails loudly rather than guessing", async () => {
		const blind = { ...(client(0, null) as object), workItemCensus: async () => null } as never;
		await expect(checkFreshnessQuick(blind, snapshot)).rejects.toThrow(/usable item count/i);
	});
});
