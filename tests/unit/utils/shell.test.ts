import { describe, expect, test } from "bun:test";
import { shellQuote } from "../../../src/utils/shell.ts";

/**
 * Quoting for commands we tell an operator to RUN. It had three byte-identical
 * private copies and no test of its own — the shape that gets fixed in one place
 * and not the others.
 *
 * The values are board data: project names with spaces, apostrophes, `$`,
 * backticks. A refusal that produces an unrunnable command is a refusal that
 * lies, and one that produces a DIFFERENTLY-runnable command is worse.
 */
describe("shellQuote", () => {
	test("wraps in single quotes, which disable every expansion", () => {
		expect(shellQuote("Data Platform")).toBe("'Data Platform'");
		// Inside single quotes these are literal, so they need no further escaping.
		expect(shellQuote("$HOME")).toBe("'$HOME'");
		expect(shellQuote("`whoami`")).toBe("'`whoami`'");
		expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
		expect(shellQuote('say "hi"')).toBe(`'say "hi"'`);
	});

	test("an apostrophe closes, escapes and reopens — the only special case", () => {
		// `Jane's Board` -> 'Jane'"'"'s Board'
		expect(shellQuote("Jane's Board")).toBe(`'Jane'"'"'s Board'`);
	});

	test("every apostrophe is handled, not just the first", () => {
		// `replaceAll`, not `replace`. A single-replace version quotes the first
		// and leaves the rest to break out of the string.
		expect(shellQuote("a'b'c")).toBe(`'a'"'"'b'"'"'c'`);
	});

	test("the result actually round-trips through a real shell", async () => {
		// The claim is about a SHELL, so ask one. Asserting the string shape alone
		// would pass for a quoting scheme that no shell agrees with.
		for (const value of ["Data Platform", "Jane's Board", "$HOME", "`id`", 'a"b', "a'b'c", "  "]) {
			const proc = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]);
			expect(proc.stdout.toString()).toBe(value);
		}
	});

	test("an empty string stays an argument rather than vanishing", () => {
		expect(shellQuote("")).toBe("''");
		const proc = Bun.spawnSync(["sh", "-c", `printf '%s' ${shellQuote("")}`]);
		expect(proc.stdout.toString()).toBe("");
	});
});
