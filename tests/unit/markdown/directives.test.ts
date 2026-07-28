import { describe, expect, test } from "bun:test";
import {
	formatDevDays,
	hasEffortLine,
	injectEffortLine,
	parseEffortDays,
	parseYamlEffort,
} from "../../../src/markdown/directives.ts";

describe("parseEffortDays", () => {
	test("reads a decimal dev-day effort from the body line", () => {
		expect(parseEffortDays("Narrative.\n\n**Effort:** 2.5 dev-days")).toBe(2.5);
	});

	test("reads an integer and a fractional value", () => {
		expect(parseEffortDays("**Effort:** 8 dev-days")).toBe(8);
		expect(parseEffortDays("**Effort:** 0.5 dev-days")).toBe(0.5);
	});

	test("is case-insensitive and tolerates dev-day / dev day singular/plural", () => {
		expect(parseEffortDays("**effort:** 1 dev-day")).toBe(1);
		expect(parseEffortDays("**Effort:** 3 dev days")).toBe(3);
	});

	test("returns null when there is no effort line", () => {
		expect(parseEffortDays("Just a narrative with no effort.")).toBeNull();
	});

	test("does not read effort out of a fenced code block", () => {
		const body = "Narrative.\n\n```markdown\n**Effort:** 7 dev-days\n```\n";
		expect(parseEffortDays(body)).toBeNull();
	});

	test("recognizes effort only in the narrative, not after the AC heading", () => {
		const body = "Narrative.\n\n### Acceptance Criteria\n- [ ] x\n\n**Effort:** 2.5 dev-days";
		expect(parseEffortDays(body)).toBeNull();
	});

	test("a soft-wrapped unit is joined by the renderer and recognized (render-consistent)", () => {
		// The canonical (rendered->recovered) form collapses the soft break to a space,
		// which is exactly what the Plane description would store, so we read it as effort.
		expect(parseEffortDays("**Effort:** 2 dev\ndays")).toBe(2);
	});

	test("recognizes effort embedded in indented code as NOT effort (renderer fences it)", () => {
		// 4-space indent -> CommonMark indented code -> canonical fences it -> skipped.
		expect(parseEffortDays("Narrative.\n\n    **Effort:** 2 dev-days")).toBeNull();
	});

	test("an unclosed raw <pre> block escapes the line so it is not read as effort", () => {
		expect(parseEffortDays("Text.\n\n<pre>\nunclosed\n\n**Effort:** 2 dev-days")).toBeNull();
	});

	test("underscore-bold __Effort:__ is recognized (canonical normalizes it)", () => {
		expect(parseEffortDays("Narrative.\n\n__Effort:__ 3 dev-days")).toBe(3);
	});

	test("a closed-ATX AC heading bounds the narrative (matches splitBody after canonicalization)", () => {
		// `### Acceptance Criteria ###` is a valid heading marked normalizes; effort after
		// it must NOT be read (consistent with the hashed narrative region).
		const body = "Narrative.\n\n### Acceptance Criteria ###\n\n**Effort:** 2 dev-days";
		expect(parseEffortDays(body)).toBeNull();
	});

	test("an AC heading hidden inside an HTML comment does not desync detection from the hash", () => {
		// raw splitBody stops at the `### Acceptance Criteria` line inside the comment,
		// so effort after it is NOT in the hashed narrative — detection must agree (null).
		const body = "N\n\n<!--\n### Acceptance Criteria\n-->\n\n**Effort:** 1 dev-days";
		expect(parseEffortDays(body)).toBeNull();
	});
});

describe("parseYamlEffort", () => {
	test("accepts a finite non-negative number or unsigned-decimal string", () => {
		expect(parseYamlEffort(2.5)).toBe(2.5);
		expect(parseYamlEffort(0)).toBe(0);
		expect(parseYamlEffort("2.5")).toBe(2.5);
	});

	test("rejects booleans, blanks, negatives, non-finite and junk (no fabricated 0)", () => {
		expect(parseYamlEffort(false)).toBeNull();
		expect(parseYamlEffort(true)).toBeNull();
		expect(parseYamlEffort(" ")).toBeNull();
		expect(parseYamlEffort("")).toBeNull();
		expect(parseYamlEffort(-1)).toBeNull();
		expect(parseYamlEffort(Number.POSITIVE_INFINITY)).toBeNull();
		expect(parseYamlEffort("nope")).toBeNull();
		expect(parseYamlEffort(null)).toBeNull();
		expect(parseYamlEffort(undefined)).toBeNull();
	});

	test("a small decimal renders without exponent and round-trips", () => {
		// String(0.0000001) === "1e-7" which the grammar rejects; parseYamlEffort must
		// accept it only if the canonical (toFixed) rendering re-parses.
		expect(parseYamlEffort(0.0000001)).toBe(0.0000001);
		expect(formatDevDays(0.0000001)).toBe("0.0000001");
		// A sub-precision magnitude cannot be rendered exactly -> rejected (no 0 fabrication).
		expect(parseYamlEffort(1e-15)).toBeNull();
	});

	test("rejects magnitudes that lose precision or exceed the sane bound", () => {
		// 16-digit integer STRING > 2^53: Number() would silently alter it.
		expect(parseYamlEffort("9007199254740993")).toBeNull();
		expect(parseYamlEffort(9007199254740993)).toBeNull();
		expect(parseYamlEffort(100_001)).toBeNull();
		expect(parseYamlEffort(100_000)).toBe(100_000);
	});
});

describe("formatDevDays", () => {
	test("drops trailing zeros", () => {
		expect(formatDevDays(2.5)).toBe("2.5");
		expect(formatDevDays(2)).toBe("2");
		expect(formatDevDays(0.5)).toBe("0.5");
		expect(formatDevDays(2.5)).toBe(formatDevDays(2.5));
		expect(formatDevDays(Number("2.50"))).toBe("2.5");
	});
});

describe("injectEffortLine", () => {
	test("inserts before an Acceptance Criteria heading, keeping it in the narrative", () => {
		const body = "Narrative here.\n\n### Acceptance Criteria\n\n- [ ] a thing";
		const out = injectEffortLine(body, 2.5);
		expect(out).toBe(
			"Narrative here.\n\n**Effort:** 2.5 dev-days\n\n### Acceptance Criteria\n\n- [ ] a thing",
		);
		// The effort line is before the AC heading (survives --sync-criteria).
		expect(out.indexOf("**Effort:**")).toBeLessThan(out.indexOf("### Acceptance Criteria"));
	});

	test("appends when there is no Acceptance Criteria heading", () => {
		expect(injectEffortLine("Just a narrative.", 1)).toBe(
			"Just a narrative.\n\n**Effort:** 1 dev-days",
		);
	});

	test("materializes into an empty body", () => {
		expect(injectEffortLine("", 3)).toBe("**Effort:** 3 dev-days");
	});

	test("is a no-op when an effort line already exists", () => {
		const body = "N.\n\n**Effort:** 4 dev-days";
		expect(injectEffortLine(body, 9)).toBe(body);
		expect(hasEffortLine(body)).toBe(true);
	});

	test("mixed fence markers: a ~~~ line inside a ``` block stays fenced (no false effort)", () => {
		const body = "```md\n~~~\n**Effort:** 4 dev-days\n```";
		expect(parseEffortDays(body)).toBeNull();
	});

	test("a shorter same-marker fence does not close a longer one (length rule)", () => {
		// ```` (4) opener; the ``` (3) line is content, so the fence stays open and
		// the effort line remains fenced.
		const body = "````md\ncode\n```\n**Effort:** 5 dev-days";
		expect(parseEffortDays(body)).toBeNull();
	});

	test("a longer same-marker fence DOES close a shorter opener", () => {
		// ``` (3) opener, ```` (4) closer -> closed; effort after it is real narrative.
		const body = "```\ncode\n````\n\n**Effort:** 6 dev-days";
		expect(parseEffortDays(body)).toBe(6);
	});

	test("the injected line round-trips: parse -> inject is stable", () => {
		const injected = injectEffortLine("Narrative.", 2.5);
		expect(parseEffortDays(injected)).toBe(2.5);
		expect(injectEffortLine(injected, 2.5)).toBe(injected);
	});
});
