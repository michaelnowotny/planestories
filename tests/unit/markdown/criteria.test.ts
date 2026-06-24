import { describe, expect, test } from "bun:test";
import { buildAcceptanceCriteria, joinBody, splitBody } from "../../../src/markdown/criteria.ts";

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
