import { describe, expect, test } from "bun:test";
import { buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { renderAtlasHtml } from "../../../src/atlas/render.ts";

const FILE = `---
project: "P"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Done
\`\`\`

Body.

### Acceptance Criteria
- [ ] a criterion
`;

describe("renderAtlasHtml", () => {
	test("produces a self-contained page with no external network references", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html.startsWith("<!doctype html>")).toBe(true);
		// Offline + self-contained: no CDN scripts, remote stylesheets, or fonts.
		expect(html).not.toMatch(/https?:\/\/[^"']*(cdn|jsdelivr|unpkg|fonts|googleapis)/i);
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toMatch(/<link[^>]+stylesheet/i);
		// Data + project are embedded.
		expect(html).toContain("const GRAPH =");
		expect(html).toContain('"project":"P"');
	});

	test("the empty-state overlay is defeated by a global [hidden] guard", () => {
		// `.empty` sets `display:flex`, which overrides the UA `[hidden]{display:none}`
		// rule — so an explicit guard is required or the overlay bleeds over the tree.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).toMatch(/\[hidden\]\{display:none!important\}/);
	});

	test("the auto-dark media query is well-formed (no selector list bleeding into @media)", () => {
		// A dangling `:root[data-theme=dark],` before `@media` is invalid CSS and voids
		// the whole prefers-color-scheme block.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).not.toMatch(/data-theme=dark\],\s*@media/);
		expect(html).toMatch(
			/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{/,
		);
	});

	test("escapes a </script> in the embedded data so it cannot break out", () => {
		const evil = `---
project: "P"
---

## </script> pwn

\`\`\`yaml
status: Done
\`\`\`

Body.

### Acceptance Criteria
- [ ] c
`;
		const html = renderAtlasHtml(buildAtlasFromFile(evil, "x.md"));
		// The raw closing tag with the payload text must not appear...
		expect(html).not.toContain("</script> pwn");
		// ...it is unicode-escaped in the embedded JSON instead.
		expect(html).toContain("\\u003c/script> pwn");
	});
});
