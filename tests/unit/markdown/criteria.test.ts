import { describe, expect, test } from "bun:test";
import {
	buildAcceptanceCriteria,
	joinBody,
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
