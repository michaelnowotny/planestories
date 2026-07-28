import { describe, expect, test } from "bun:test";
import { parseMarkdownFile } from "../../../src/markdown/parser.ts";
import { serializeStories } from "../../../src/markdown/serializer.ts";
import { hashStoryPayload } from "../../../src/sync/story-hash.ts";

function parse(yaml: string, body = "Narrative.") {
	return parseMarkdownFile(
		`## Story

\`\`\`yaml
plane_identifier: ENG-10
${yaml}
\`\`\`

${body}
`,
		"relations.md",
	).stories;
}

describe("dependency markdown", () => {
	test("parses YAML lists and comma strings with deterministic normalization", () => {
		const [story] = parse(`blocked_by: [eng-2, ENG-1, Eng-2]
blocks: eng-5, ENG-3, eng-5
relates_to: [eng-9, ENG-8]`);

		expect(story?.blockedBy).toEqual(["ENG-1", "ENG-2"]);
		expect(story?.blocks).toEqual(["ENG-3", "ENG-5"]);
		expect(story?.relatesTo).toEqual(["ENG-8", "ENG-9"]);
	});

	test("merges and strips bold dependency body directives but leaves fenced examples", () => {
		const [story] = parse(
			"blocked_by: [ENG-3]",
			`Before.

**Depends on:** eng-2, ENG-3
__Blocks:__ eng-6

\`\`\`md
**Blocks:** ENG-99
\`\`\`

    **Blocks:** ENG-98

After.`,
		);

		expect(story?.blockedBy).toEqual(["ENG-2", "ENG-3"]);
		expect(story?.blocks).toEqual(["ENG-6"]);
		expect(story?.body).not.toContain("**Depends on:** eng-2");
		expect(story?.body).not.toContain("__Blocks:__ eng-6");
		expect(story?.body).toContain("**Blocks:** ENG-99");
		expect(story?.body).toContain("**Blocks:** ENG-98");
	});

	test("drops a self-reference and retains a validation error", () => {
		const [story] = parse("blocks: [ENG-10, ENG-11]");
		expect(story?.blocks).toEqual(["ENG-11"]);
		expect(story?.relationValidationErrors?.[0]).toContain("cannot reference itself");
	});

	test("serializes canonical YAML and round-trips stably", () => {
		const [story] = parse(`blocked_by: eng-2, ENG-1
blocks: [ENG-4]
relates_to: [eng-8]`);
		expect(story).toBeDefined();
		const serialized = serializeStories([story!]);
		expect(serialized).toContain("blocked_by: [ENG-1, ENG-2]");
		expect(serialized).toContain("blocks: [ENG-4]");
		expect(serialized).toContain("relates_to: [ENG-8]");
		expect(serialized).not.toContain("**Depends on:**");

		const reparsed = parseMarkdownFile(serialized, "roundtrip.md").stories[0];
		expect(reparsed?.blockedBy).toEqual(story?.blockedBy);
		expect(reparsed?.blocks).toEqual(story?.blocks);
		expect(reparsed?.relatesTo).toEqual(story?.relatesTo);
	});

	test("hash changes with dependencies but ignores their ordering and case", () => {
		const [base] = parse("blocked_by: [ENG-1, ENG-2]");
		const [reordered] = parse("blocked_by: [eng-2, eng-1]");
		const [changed] = parse("blocked_by: [ENG-1, ENG-3]");
		const options = { syncCriteria: false, labels: [] };
		expect(hashStoryPayload(base!, options)).toBe(hashStoryPayload(reordered!, options));
		expect(hashStoryPayload(base!, options)).not.toBe(hashStoryPayload(changed!, options));
	});
});
