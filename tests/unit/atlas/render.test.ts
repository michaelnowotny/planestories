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

	test("is dark-only cockpit chrome (the light theme + Color-by are retired)", () => {
		// Design decision (docs/DESIGN_atlas-cockpit.md 5): the cockpit is inherently
		// dark; the old theme toggle, prefers-color-scheme block, and Color-by
		// dropdown are deliberate losses. Guard against their resurrection.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).not.toContain("prefers-color-scheme");
		expect(html).not.toContain("data-theme");
		expect(html).not.toContain('id="colorby"');
	});

	test("the embedded SCRIPT is syntactically valid JavaScript", () => {
		// The script is a template string tsc does NOT check. Extract the module
		// body between the <script> tags and parse it (GRAPH line included).
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
		expect(m).not.toBeNull();
		expect(() => new Function(m?.[1] as string)).not.toThrow();
	});

	test("carries the terraforming ladder + selection amber (design anchors)", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		// One world per status group, planets never stars.
		for (const anchor of ['"earth"', '"mars"', '"ice"', '"rock"', '"cinder"']) {
			expect(html).toContain(anchor);
		}
		// Amber is attention-only: the selection pulsar constant must be present.
		expect(html).toContain("#ffb054");
		// Effort drives size: the log2 weight formula is in the script.
		expect(html).toContain("Math.log2");
	});

	test("pins the measured LOD + physics constants (load-bearing calibration)", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		// Areal-spacing LOD driver + the measured gas band (docs/DESIGN + probe).
		expect(html).toContain("Math.sqrt(Math.PI*extent*extent/Math.max(1,cnt))");
		expect(html).toContain("sstep(24,42,sp)");
		// Unknown effort renders at the honest mid-weight of the clamp band.
		expect(html).toContain("n.effortDays==null?5.7:");
		// The force physics survived the presentation rewrite unchanged.
		expect(html).toContain("const REP=300");
		expect(html).toContain("REP*7");
		expect(html).toContain('e.type==="parent"?a.r+16');
	});

	test("embeds effortDays + priority in the GRAPH payload (null preserved)", () => {
		const file = [
			"---",
			'project: "P"',
			"---",
			"",
			"## As a user, I want X, so that Y",
			"",
			"```yaml",
			"status: Done",
			"priority: high",
			"```",
			"",
			"Body.",
			"",
			"**Effort:** 2.5 dev-days",
			"",
			"### Acceptance Criteria",
			"- [ ] a criterion",
		].join("\n");
		const html = renderAtlasHtml(buildAtlasFromFile(file, "x.md"));
		expect(html).toContain('"effortDays":2.5');
		expect(html).toContain('"priority":"high"');
		// And absent values stay null in the embed — never coerced to 0.
		const bare = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(bare).toContain('"effortDays":null');
		expect(bare).toContain('"priority":null');
	});

	test("escapes the title exactly once", () => {
		const file = [
			"---",
			'project: "A&B"',
			"---",
			"",
			"## As a user, I want X, so that Y",
			"",
			"Body.",
		].join("\n");
		const html = renderAtlasHtml(buildAtlasFromFile(file, "x.md"));
		expect(html).toContain("<title>A&amp;B — Project Atlas</title>");
		expect(html).not.toContain("&amp;amp;");
	});

	test("sidebar hrefs are scheme-guarded (no javascript: URLs)", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		// The Open in Plane anchors must route through the http(s)-only guard.
		expect(html).toMatch(/function safeUrl\(u\)\{return u&&\/\^https\?:/);
		expect(html).toContain("safeUrl(n.url)");
		expect(html).toContain("safeUrl(h.url)");
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
