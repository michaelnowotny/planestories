import { describe, expect, test } from "bun:test";
import { escapeHtml } from "../../../src/utils/html.ts";

/**
 * Consolidated from four near-copies that had drifted into two contracts: three
 * escaped `"` and one did not. The weak one only ever reached element content
 * (harmless), so there was no live defect — but it was named identically to the
 * strong ones, so reusing it in an attribute would have produced a breakout with
 * no warning. These pin the stronger contract, which is the only reason merging
 * them is safe.
 */
describe("escapeHtml", () => {
	test("escapes the four characters that matter in BOTH contexts", () => {
		expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
	});

	test("is safe inside an attribute value — the case the weak copy failed", () => {
		const attr = `<p data-x="${escapeHtml('a" onclick="evil()')}">`;
		// The injected quote must not close the attribute.
		expect(attr).toBe('<p data-x="a&quot; onclick=&quot;evil()">');
	});

	test("replaces & FIRST, so nothing is double-escaped", () => {
		// `<` → `&lt;` and then a later `&` pass would give `&amp;lt;`. Ordering is
		// the whole correctness of this function.
		expect(escapeHtml("<")).toBe("&lt;");
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});

	test("leaves ordinary text untouched", () => {
		expect(escapeHtml("deployed abc123; p95 200ms -> 80ms")).toBe(
			"deployed abc123; p95 200ms -&gt; 80ms",
		);
	});

	test("handles an empty string", () => {
		expect(escapeHtml("")).toBe("");
	});
});
