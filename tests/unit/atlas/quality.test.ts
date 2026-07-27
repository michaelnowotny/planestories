import { describe, expect, test } from "bun:test";
import { assessQuality } from "../../../src/atlas/quality.ts";

describe("assessQuality", () => {
	test("flags a story with no acceptance criteria", () => {
		const a = assessQuality({ criteria: [], description: "x".repeat(60) });
		expect(a.ok).toBe(false);
		expect(a.flags).toContain("no acceptance criteria");
	});

	test("flags subjective UI + unquantified performance language", () => {
		const a = assessQuality({
			criteria: [{ text: "The UI should be intuitive and feel fast and look clean and modern" }],
			description: "x".repeat(60),
		});
		expect(a.ok).toBe(false);
		expect(a.flags).toContain("subjective UI language");
		expect(a.flags).toContain("unquantified performance");
	});

	test("does not flag a performance word when a numeric threshold is present", () => {
		const a = assessQuality({
			criteria: [{ text: "The page loads fast, under 200ms at p95" }],
			description: "x".repeat(60),
		});
		expect(a.flags).not.toContain("unquantified performance");
	});

	test("passes concrete, testable criteria with a real description", () => {
		const a = assessQuality({
			criteria: [{ text: "An unknown column returns HTTP 400 naming the offender" }],
			description: "A clear description with more than enough detail to implement it.",
		});
		expect(a.ok).toBe(true);
		expect(a.flags).toEqual([]);
	});

	test("flags a thin description when criteria exist", () => {
		const a = assessQuality({
			criteria: [{ text: "does a concrete thing verified by a test" }],
			description: "Short.",
		});
		expect(a.flags).toContain("thin description");
	});
});
