import { describe, expect, test } from "bun:test";
import { formatCriticalPath } from "../../../src/cli/commands/critical-path.ts";
import type { CriticalPathResult } from "../../../src/sync/critical_path.ts";

/**
 * The formatter is where the claim reaches a human, so this is where "never
 * print more certainty than you have" is actually enforced. It had NO tests —
 * the commit message asserted the formatter "physically cannot print a bare
 * figure" and nothing checked it.
 */
function computed(over: Partial<Extract<CriticalPathResult, { ok: true }>> = {}) {
	return {
		ok: true as const,
		chain: [
			{
				identifier: "P-1",
				title: "First",
				effortDays: 2,
				status: "Todo",
				done: false,
				earliestStart: 0,
				earliestFinish: 2,
			},
		],
		totalDays: 2,
		unestimated: 0,
		unestimatedIdentifiers: [],
		isLowerBound: false,
		slackByIdentifier: {},
		biggestLever: null,
		consideredLeaves: 10,
		doneLeaves: 3,
		connectedLeaves: 2,
		expandedEdges: 0,
		cycles: [] as [],
		...over,
	};
}

describe("critical-path output", () => {
	test("a lower bound is NEVER printed as a bare figure", () => {
		const out = formatCriticalPath(computed({ totalDays: 5, unestimated: 3, isLowerBound: true }));
		expect(out).toContain("at least 5");
		expect(out).toMatch(/3 connected item\(s\) have no/);
		expect(out).toContain("HIGHER");
		// And the exact-looking phrasing must NOT appear.
		expect(out).not.toMatch(/Critical path: 5 dev-days/);
	});

	test("an exact total omits the hedge", () => {
		const out = formatCriticalPath(computed({ totalDays: 6 }));
		expect(out).toContain("Critical path: 6 dev-days");
		expect(out).not.toContain("at least");
		expect(out).not.toContain("HIGHER");
	});

	test("says the number is a PARALLEL floor, not calendar time", () => {
		// A solo developer reads "12.5 dev-days" as "when am I done". It is the
		// dependency floor under unlimited parallelism; independent work is
		// excluded by design, so the output has to say so.
		expect(formatCriticalPath(computed())).toContain("parallel");
	});

	test("a refusal reads as a refusal, never as an empty board", () => {
		const out = formatCriticalPath({
			ok: false,
			cycles: [["DATA-2569", "DATA-2570", "DATA-2569"]],
			consideredLeaves: 10,
			doneLeaves: 2,
		});
		expect(out).toContain("Cannot compute");
		expect(out).toContain("cycle");
		expect(out).toContain("DATA-2569");
		// The empty-board wording must not appear for a cycle: they mean opposite
		// things and only one of them is safe to act on.
		expect(out).not.toContain("nothing on this board blocks anything else");
	});

	test("an empty board reads as empty, not as a refusal", () => {
		const out = formatCriticalPath(computed({ chain: [], connectedLeaves: 0 }));
		expect(out).toContain("nothing on this board blocks anything else");
		expect(out).not.toContain("Cannot compute");
	});

	test("reports epic-edge expansion so the count is explicable", () => {
		expect(formatCriticalPath(computed({ expandedEdges: 4 }))).toContain(
			"4 edge(s) expanded from epic endpoints",
		);
	});
});
