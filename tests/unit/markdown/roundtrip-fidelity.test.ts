import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../../../src/markdown/html.ts";
import { parseMarkdownFile } from "../../../src/markdown/parser.ts";

/**
 * The export -> edit -> import round-trip must be a FIXED POINT on the set of
 * work items. It was not, and none of the three ways it broke needed adversarial
 * input.
 *
 * All three were measured before the fix, against the real functions:
 *
 *   `<h2>` in a Plane description  -> 2 stories, real ticket loses its body
 *   "## " inside a ```fence```     -> 2 stories, real ticket truncated at the fence
 *   CRLF line endings             -> planeId null, an already-linked item RE-CREATED
 *
 * Each of them creates a phantom work item on a real board, which is the worst
 * failure this tool has: it is a destructive write dressed as a successful sync.
 */

const FRONT = ["---", 'project: "P"', "---", ""];

function parse(lines: string[], eol = "\n") {
	return parseMarkdownFile([...FRONT, ...lines].join(eol), "x.md");
}

describe("a heading in a story BODY does not split the story", () => {
	test("an <h2> from a Plane description survives the round-trip as one story", () => {
		// Someone picked "Heading 2" in the Plane editor. Nothing unusual.
		const body = htmlToMarkdown("<p>Intro.</p><h2>Design Section</h2><p>Details.</p>");
		const result = parse(["## Real Ticket", "", "```yaml", "plane_id: aaaa-bbbb", "```", "", body]);

		expect(result.stories).toHaveLength(1);
		expect(result.stories[0]?.title).toBe("Real Ticket");
		expect(result.stories[0]?.planeId).toBe("aaaa-bbbb");
		// The section text stays WITH its ticket rather than becoming a new one.
		expect(result.stories[0]?.body).toContain("Design Section");
		expect(result.stories[0]?.body).toContain("Details.");
	});
});

describe("a fenced code block is not story structure", () => {
	test("`## ` inside a fence neither splits nor truncates", () => {
		// This repo's own README contains lines of exactly this shape.
		const result = parse([
			"## Docs for authors",
			"",
			"Body before.",
			"",
			"```markdown",
			"## Example Template",
			"- [ ] a criterion",
			"```",
			"",
			"Trailing narrative that belongs to the real story.",
		]);

		expect(result.stories).toHaveLength(1);
		expect(result.stories[0]?.title).toBe("Docs for authors");
		// The trailing narrative used to be stolen by the phantom story.
		expect(result.stories[0]?.body).toContain("Trailing narrative");
		expect(result.stories[0]?.body).toContain("## Example Template");
	});

	test("a real story AFTER a fence is still found", () => {
		// The fix must not swing the other way and swallow genuine headings.
		const result = parse([
			"## First",
			"",
			"```markdown",
			"## Not A Story",
			"```",
			"",
			"## Second",
			"",
			"Body.",
		]);
		expect(result.stories.map((s) => s.title)).toEqual(["First", "Second"]);
	});

	test("a tilde fence counts too, and an unterminated fence does not eat the file", () => {
		expect(
			parse(["## A", "", "~~~", "## Inside", "~~~", "", "## B", "", "x"]).stories,
		).toHaveLength(2);
		// An unclosed fence is malformed input; it must not silently drop stories
		// that follow it into a black hole.
		const unterminated = parse(["## A", "", "```", "## Inside", "", "## B"]);
		expect(unterminated.stories.length).toBeGreaterThanOrEqual(1);
	});
});

describe("CRLF is a line ending, not a content change", () => {
	test("a CRLF file keeps its yaml block, so a linked story is not re-created", () => {
		// Measured before the fix: planeId null, priority null, and the raw fence
		// pushed into the body — so import would CREATE a duplicate of an item
		// that already exists.
		const result = parse(
			["## CRLF story", "", "```yaml", "plane_id: 1111-2222", "priority: high", "```", "", "Body."],
			"\r\n",
		);

		expect(result.stories[0]?.planeId).toBe("1111-2222");
		expect(result.stories[0]?.priority).toBe("high");
		expect(result.stories[0]?.body).not.toContain("```yaml");
	});

	test("CRLF body keeps its criteria section, with no carriage returns left in it", () => {
		const result = parse(
			["## CRLF story", "", "Body.", "", "### Acceptance Criteria", "- [ ] one", "- [x] two"],
			"\r\n",
		);
		const body = result.stories[0]?.body ?? "";
		expect(body).toContain("### Acceptance Criteria");
		expect(body).toContain("- [ ] one");
		expect(body).toContain("- [x] two");
		// A stray \r would round-trip into the board description and back out again.
		expect(body).not.toContain("\r");
	});
});

describe("YAML that is not a scalar is REFUSED, never coerced", () => {
	// The null-ban, at the file boundary. `Number([])` is 0 in JavaScript, so
	// `estimate: []` used to reach the wire as an authoritative estimate of ZERO —
	// and hashed identically to a genuine `estimate: 0`, so skip-unchanged would
	// never revisit it. `estimate: true` became 1; `plane_id:` as a map became
	// the string "[object Object]".
	//
	// Absence must stay absent. A wrong TYPE is a malformed file, not a value.
	const withYaml = (line: string) =>
		parse(["## S", "", "```yaml", line, "```", "", "Body long enough to matter."]);

	test("a list or map where a number belongs does not become a number", () => {
		expect(() => withYaml("estimate: []")).toThrow(/estimate/i);
		expect(() => withYaml("estimate: {}")).toThrow(/estimate/i);
	});

	test("a boolean is not silently 1 or 0", () => {
		expect(() => withYaml("estimate: true")).toThrow(/estimate/i);
	});

	test("a non-finite number is refused rather than becoming null", () => {
		// `.inf` previously produced `null` locally while the hash was computed
		// from Infinity — so the story looked permanently synced.
		expect(() => withYaml("estimate: .inf")).toThrow(/estimate/i);
	});

	test("a list or map where a string belongs does not become '[object Object]'", () => {
		expect(() => withYaml("plane_id: {a: 1}")).toThrow(/plane_id/i);
		expect(() => withYaml("plane_id: [x, y]")).toThrow(/plane_id/i);
	});

	test("genuine values still parse, including a real zero", () => {
		expect(withYaml("estimate: 0").stories[0]?.estimate).toBe(0);
		expect(withYaml("estimate: 2").stories[0]?.estimate).toBe(2);
		expect(withYaml("plane_id: abc-123").stories[0]?.planeId).toBe("abc-123");
		// Absent stays absent — that is the case this must NOT start rejecting.
		expect(withYaml("priority: high").stories[0]?.estimate).toBeNull();
	});
});
