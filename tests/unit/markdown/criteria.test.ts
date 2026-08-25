import { describe, expect, test } from "bun:test";
import {
	buildAcceptanceCriteria,
	joinBody,
	peerCheckboxLineIndices,
	spliceAcceptanceCriteria,
	splitBody,
} from "../../../src/markdown/criteria.ts";

describe("splitBody", () => {
	test("splits narrative from acceptance criteria", () => {
		const body = [
			"Some narrative.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] one",
			"- [x] two",
		].join("\n");

		const result = splitBody(body);
		expect(result.hasHeading).toBe(true);
		expect(result.narrative).toBe("Some narrative.");
		expect(result.criteria).toEqual([
			{ text: "one", checked: false },
			{ text: "two", checked: true },
		]);
	});

	test("no heading -> all narrative, no criteria", () => {
		const result = splitBody("Just a description.");
		expect(result.hasHeading).toBe(false);
		expect(result.narrative).toBe("Just a description.");
		expect(result.criteria).toEqual([]);
	});

	test("stops collecting at the next heading", () => {
		const body = ["### Acceptance Criteria", "- [ ] a", "## Next", "- [ ] b"].join("\n");
		const result = splitBody(body);
		expect(result.criteria).toEqual([{ text: "a", checked: false }]);
	});

	test("refuses a repeated Acceptance Criteria heading by name", () => {
		const body = [
			"Narrative.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] first",
			"",
			"### Notes",
			"",
			"Keep these notes.",
			"",
			"### Acceptance Criteria",
			"",
			"- [x] second",
			"- [ ] third",
		].join("\n");

		expect(() => splitBody(body)).toThrow(/Duplicate Acceptance Criteria heading at line 11/i);
		expect(() => spliceAcceptanceCriteria(body, [{ text: "replacement", checked: false }])).toThrow(
			/Duplicate Acceptance Criteria heading at line 11/i,
		);
	});

	test("does not mistake an Acceptance Criteria example in a code fence for a duplicate", () => {
		const body = [
			"Narrative.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] real criterion",
			"",
			"### Notes",
			"",
			"```markdown",
			"### Acceptance Criteria",
			"- [ ] example only",
			"```",
		].join("\n");

		const result = splitBody(body);

		expect(result.criteria).toEqual([{ text: "real criterion", checked: false }]);
		const fencedExample = "```markdown\n### Acceptance Criteria\n- [ ] example only\n```";
		expect(result.suffix).toContain(fencedExample);
		expect(spliceAcceptanceCriteria(body, [{ text: "real criterion", checked: true }])).toBe(
			body.replace("- [ ] real criterion", "- [x] real criterion"),
		);
	});

	test("ignores a fenced Acceptance Criteria example before the real section", () => {
		const body = [
			"Narrative.",
			"",
			"```markdown",
			"### Acceptance Criteria",
			"- [ ] example only",
			"```",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] real criterion",
		].join("\n");

		const result = splitBody(body);

		expect(result.narrative).toContain(
			"```markdown\n### Acceptance Criteria\n- [ ] example only\n```",
		);
		expect(result.criteria).toEqual([{ text: "real criterion", checked: false }]);
		expect(spliceAcceptanceCriteria(body, [{ text: "real criterion", checked: true }])).toBe(
			body.replace("- [ ] real criterion", "- [x] real criterion"),
		);
	});
});

describe("buildAcceptanceCriteria / joinBody", () => {
	test("renders a checklist", () => {
		const md = buildAcceptanceCriteria([
			{ text: "a", checked: false },
			{ text: "b", checked: true },
		]);
		expect(md).toBe("### Acceptance Criteria\n\n- [ ] a\n- [x] b");
	});

	test("empty criteria render as empty string", () => {
		expect(buildAcceptanceCriteria([])).toBe("");
	});

	test("joinBody joins narrative and criteria with a blank line", () => {
		expect(joinBody("Narrative.", "### Acceptance Criteria\n\n- [ ] a")).toBe(
			"Narrative.\n\n### Acceptance Criteria\n\n- [ ] a",
		);
		expect(joinBody("Narrative.", "")).toBe("Narrative.");
	});

	test("round-trips through split -> build", () => {
		const body = "Narrative.\n\n### Acceptance Criteria\n\n- [ ] a\n- [x] b";
		const { narrative, criteria } = splitBody(body);
		expect(joinBody(narrative, buildAcceptanceCriteria(criteria))).toBe(body);
	});
});

/**
 * Indentation decides PEER vs NESTED — and it cannot be decided by the pattern
 * alone, because both readings of a two-space checkbox are correct depending on
 * what precedes it.
 *
 * An earlier version treated ANY leading whitespace as nested. CommonMark allows
 * one to three leading spaces on a top-level list, so a legitimate file was
 * rejected with advice to "use a top-level criterion" — which it already was.
 * That refusal reached import, lint, and every file-based graph command.
 */
describe("criteria indentation", () => {
	const withCriteria = (lines: string[]) => splitBody(["Body.", "", ...lines].join("\n"));

	test.each([0, 1, 2, 3])("a list indented %i space(s) is top-level", (spaces) => {
		const pad = " ".repeat(spaces);
		const result = withCriteria([
			"### Acceptance Criteria",
			`${pad}- [ ] first`,
			`${pad}- [x] second`,
		]);
		expect(result.criteria).toHaveLength(2);
		expect(result.criteria[0]?.text).toBe("first");
		expect(result.criteria[1]?.checked).toBe(true);
	});

	test("a checkbox DEEPER than the first is nested, and refused", () => {
		// Same two spaces as the legal case above; only the context differs.
		expect(() =>
			withCriteria(["### Acceptance Criteria", "- [ ] parent", "  - [ ] child"]),
		).toThrow(/nested checkbox "child"/);
	});

	test("the refusal offers both ways out, not just one", () => {
		try {
			withCriteria(["### Acceptance Criteria", "- [ ] parent", "  - [ ] child"]);
			throw new Error("expected a refusal");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toMatch(/nested bullet/i);
			expect(message).toMatch(/outdent/i);
		}
	});

	test("an outdented checkbox re-bases rather than being called nested", () => {
		// If the first checkbox was itself indented content, a later one at column
		// zero is the real peer level — not a violation of a base set by accident.
		const result = withCriteria(["### Acceptance Criteria", "  - [ ] a", "- [ ] b"]);
		expect(result.criteria).toHaveLength(2);
	});

	test("write-back NORMALISES criterion indentation, losing nothing", () => {
		// Deliberate, and worth pinning: `spliceAcceptanceCriteria` rewrites the
		// whole section, so a cosmetically-indented list comes back at column zero.
		// That is safe here because the `### Acceptance Criteria` heading is
		// top-level by definition, so the indentation carried no structure — and
		// the alternative (threading a per-criterion indent through write-back)
		// buys nothing but a smaller diff.
		//
		// What must NOT happen is losing content or churning on every run.
		const body = ["Body.", "", "### Acceptance Criteria", "  - [ ] first", "  - [ ] second"].join(
			"\n",
		);
		const { criteria } = splitBody(body);
		const once = spliceAcceptanceCriteria(
			body,
			criteria.map((c) => ({ ...c, checked: true })),
		);

		expect(once).toContain("- [x] first");
		expect(once).toContain("- [x] second");
		// Idempotent: a second pass is a no-op, so the normalisation settles rather
		// than producing a fresh diff on every import.
		const twice = spliceAcceptanceCriteria(once, splitBody(once).criteria);
		expect(twice).toBe(once);
	});

	test("a fenced checkbox is not a criterion", () => {
		// Recorded P2 from review: fenced state was not applied while collecting.
		const result = withCriteria([
			"### Acceptance Criteria",
			"- [ ] real",
			"",
			"```markdown",
			"- [ ] an example in a code fence",
			"```",
		]);
		expect(result.criteria).toHaveLength(1);
		expect(result.criteria[0]?.text).toBe("real");
	});
});

/**
 * Peer vs nested is decided by CommonMark's CONTENT COLUMN, not by comparing to
 * the first checkbox.
 *
 * The first-checkbox heuristic was blind to what came BEFORE a checkbox, so a
 * checkbox nested under an ordinary bullet silently became an acceptance
 * criterion — and it rejected legal mixed peer indentation. Both measured.
 */
describe("criteria nesting follows list structure", () => {
	const withCriteria = (lines: string[]) => splitBody(["Body.", "", ...lines].join("\n"));

	test("a checkbox inside an ORDINARY bullet is not a criterion", () => {
		// Measured before: returned "nested checkbox" as a peer criterion, so it
		// would have been synced to the board as one.
		expect(() =>
			withCriteria([
				"### Acceptance Criteria",
				"- ordinary bullet",
				"  - [ ] nested checkbox",
				"- [ ] peer criterion",
			]),
		).toThrow(/nested checkbox/i);
	});

	test("legal mixed peer indentation is accepted", () => {
		// 2, 0, then 1 space. All three are peers: 1 is short of the content column
		// (2) opened by the item above it. Measured before: threw on the third.
		const result = withCriteria(["### Acceptance Criteria", "  - [ ] a", "- [ ] b", " - [ ] c"]);
		expect(result.criteria.map((c) => c.text)).toEqual(["a", "b", "c"]);
	});

	test("a peer checkbox CLOSES a deeper container rather than inheriting it", () => {
		// After a nested block ends, an outdented checkbox is a peer again.
		const result = withCriteria([
			"### Acceptance Criteria",
			"- [ ] first",
			"  detail belonging to first",
			"- [ ] second",
		]);
		expect(result.criteria.map((c) => c.text)).toEqual(["first", "second"]);
	});

	test("an ordered-list marker opens a container too", () => {
		expect(() =>
			withCriteria(["### Acceptance Criteria", "1. ordered bullet", "   - [ ] inside it"]),
		).toThrow(/nested checkbox/i);
	});
});

/**
 * `splitBody` and `groom --write-back` must agree on WHICH checkboxes are
 * criteria, because `::ac1` means "the second peer criterion" to one of them and
 * indexes lines for the other.
 *
 * They did not. Write-back counted every matching line, so a nested checkbox
 * shifted the numbering and `::ac1` could tick the wrong box — writing a state
 * onto someone's board that nobody asked for. Widening CHECKBOX_LINE to accept
 * legally-indented lists made it worse: indented checkboxes previously did not
 * match at all, so write-back skipped them by accident.
 *
 * One classifier now. This pins that they cannot drift apart again.
 */
describe("the peer-checkbox classifier is shared", () => {
	const cases: Array<[string, string[]]> = [
		["flat", ["- [ ] one", "- [x] two"]],
		["indented list", ["  - [ ] one", "  - [ ] two"]],
		["detail lines", ["- [ ] one", "  a detail", "- [ ] two"]],
		["nested under a bullet", ["- bullet", "  - [ ] inside", "- [ ] peer"]],
		["fenced example", ["- [ ] real", "```md", "- [ ] fake", "```", "- [ ] also real"]],
		["mixed peer indents", ["  - [ ] a", "- [ ] b", " - [ ] c"]],
	];

	test.each(cases)("%s: the two agree on the criteria set", (_name, lines) => {
		const peers = peerCheckboxLineIndices(lines);
		let parsed: ReturnType<typeof splitBody> | null = null;
		try {
			parsed = splitBody(["Body.", "", "### Acceptance Criteria", ...lines].join("\n"));
		} catch {
			// A refused structure is agreement of a different kind: the classifier
			// must not silently hand write-back a set that parsing rejects.
			parsed = null;
		}
		if (parsed === null) return;
		expect(peers).toHaveLength(parsed.criteria.length);
		for (const [n, index] of peers.entries()) {
			expect(lines[index]).toContain(parsed.criteria[n]?.text ?? "");
		}
	});

	test("a fenced checkbox is never a peer", () => {
		expect(peerCheckboxLineIndices(["```md", "- [ ] fake", "```"])).toEqual([]);
	});
});
