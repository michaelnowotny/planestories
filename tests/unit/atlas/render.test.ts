import { describe, expect, test } from "bun:test";
import { buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { renderAtlasHtml } from "../../../src/atlas/render.ts";
import { computeCriticalPath } from "../../../src/sync/critical_path.ts";

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

	test("dossier heaviest-stories controls: ALL/OPEN toggle + expandable orbit list", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).toContain('id="seHeavyTog"');
		// OPEN filters out completed AND cancelled (not-yet-done, honestly).
		expect(html).toContain('s2.statusGroup!=="completed"&&s2.statusGroup!=="cancelled"');
		// The "more in orbit" line is a click-to-expand control with a collapse state.
		expect(html).toContain("IN ORBIT \\u2014 SHOW ALL");
		expect(html).toContain("SHOW FEWER \\u2014 TOP 5");
		// Expanded rows keep the visibility guard (no fly to hidden nodes).
		expect(html).toContain("heavyMax=heavyMax===5?Infinity:5");
	});

	test("assignee filter chips: vocabulary embedded, sentinel filter, sidebar cell", () => {
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		// The vocabulary rides the GRAPH payload (empty on this file — still present).
		expect(html).toContain('"assignees":[]');
		// Older embeds without the field must not break the script.
		expect(html).toContain("GRAPH.assignees||[]");
		// The unassigned sentinel is a Symbol — NO string assignee can collide
		// (Codex round-1: a file could literally set assignee: "::unassigned::").
		expect(html).toContain('Symbol("unassigned")');
		expect(html).toContain("state.assigneeOn.has(n.assignee||UNASSIGNED)");
		expect(html).toContain('id="sbAssigneeCell"');
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

describe("per-frame allocation (the reheat crash)", () => {
	test("the nebula is drawn from a BOUNDED sprite cache, not per-frame gradients", () => {
		// Before this, drawNebula built three radial gradients per hub PER FRAME —
		// ~144 a frame at 48 hubs, ~58,000 across one reheat, each composited with
		// "lighter" (an offscreen pass). Pressing R crashed the browser hard enough
		// to need a restart. Sprites are cached and the cache is CAPPED, so the fix
		// cannot become the next unbounded allocation.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).toContain("function nebulaSprite(");
		expect(html).toContain("NSPR_CAP");
		expect(html).toContain("if(NSPR.size>=NSPR_CAP)NSPR.clear()");
		// Alpha must stay OUT of the cache key or fading multiplies the variants.
		expect(html).toContain("x.globalAlpha=neb*dim;");
	});
});

describe("scoped drag relaxation", () => {
	test("gravity is GLOBAL-ONLY, or a scoped neighbourhood collapses to the origin", () => {
		// The force model is not decomposable. Gravity pulls each body toward the
		// origin in proportion to its distance, balanced in the full simulation by
		// repulsion from every other node. Scoped to ~70 bodies only those push
		// back, gravity wins, and the dragged cluster slides into the centre and
		// piles up — which is exactly what shipped and had to be withdrawn.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(html).toContain("if(!inScope){p.vx-=p.x*GRAV*alpha");
		// The scoped step must exist and be driven by its own alpha, so a drag
		// never re-solves the whole board.
		expect(html).toContain("function tick(scope)");
		expect(html).toContain("if(dragScope&&dragAlpha>AMIN)");
		// A spring with neither end in scope does no work.
		expect(html).toContain("if(!sIn&&!tIn)continue;");
	});
});

describe("effort visibility (operator decisions A/B/C)", () => {
	// These parse the EMBEDDED PAYLOAD instead of grepping the template. An earlier
	// version of this block asserted that source strings existed, which let a
	// mutation replace the whole computation and stay green — the review called it
	// theatre, correctly.
	const embedded = (html: string, name: string) => {
		const m = html.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`));
		if (!m) throw new Error(`no embedded ${name}`);
		return JSON.parse((m[1] as string).replace(/\\u003c/g, "<"));
	};

	test("R is gone — it re-solved to the same arrangement and only cost a stall", () => {
		expect(renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"))).not.toContain('k==="r"');
	});

	test("the embedded floor EQUALS what computeCriticalPath returns", () => {
		const graph = buildAtlasFromFile(FILE, "x.md");
		const cp = computeCriticalPath(graph);
		const got = embedded(renderAtlasHtml(graph), "CP");
		// The fixture has no dependency edges, so the honest answer is "none" —
		// NOT a floor of 0 dev-days, which is absence dressed as a measurement.
		expect(cp.ok && cp.chain.length).toBe(0);
		expect(got).toEqual({ state: "none" });
	});

	test("a partial relation sweep embeds INCOMPLETE, never a number", () => {
		// The HTML outlives the stderr warning. Emailed and opened tomorrow, a
		// floor computed from a graph with missing edges reads as exact.
		const got = embedded(
			renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"), {
				coverage: { kind: "partial", failures: 3 },
			}),
			"CP",
		);
		expect(got.state).toBe("incomplete");
		expect(got.missing).toBe(3);
		expect(got).not.toHaveProperty("totalDays");
	});

	test("a SKIPPED sweep is not published as a board with no dependencies", () => {
		// `--no-dependencies` used to arrive here as `relationFailures === 0` and
		// render as state `none`, whose tooltip is a statement of fact about the
		// BOARD: "nothing blocks anything else". The graph had no edges because
		// nobody fetched any — absence of the question published as its answer.
		const html = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"), {
			coverage: { kind: "skipped" },
		});
		const got = embedded(html, "CP");
		expect(got.state).toBe("skipped");
		expect(got).not.toHaveProperty("totalDays");
		expect(html).toContain("relations were never fetched");
		// The sibling cells derived from edges must not print 0 either — three cells
		// agreeing on a graph nobody fetched is three lies, not one.
		expect(html).toContain("Not measured");
	});

	// A fixture that actually EXERCISES the set: two linked stories, one with no
	// estimate. The plain FILE fixture has no dependency edges, so both sides come
	// out empty and the comparison passes no matter what — the review's point
	// about tests that cannot discriminate, arriving in the replacement for a test
	// that could not discriminate.
	const LINKED = [
		"---",
		'project: "P"',
		"---",
		"",
		"## The epic",
		"",
		"```yaml",
		"kind: epic",
		"plane_identifier: P-1",
		"```",
		"",
		"### Why is this needed?",
		"Because.",
		"",
		"## As a dev, I want A, so that B",
		"",
		"```yaml",
		"plane_identifier: P-2",
		"parent: P-1",
		"blocked_by: [P-3]",
		"```",
		"",
		"**Effort:** 2 dev-days",
		"",
		"Body text that is long enough to be meaningful.",
		"",
		"### Acceptance Criteria",
		"- [ ] something concrete",
		"",
		"## As a dev, I want C, so that D",
		"",
		"```yaml",
		"plane_identifier: P-3",
		"parent: P-1",
		"```",
		"",
		"Body text that is long enough to be meaningful.",
		"",
		"### Acceptance Criteria",
		"- [ ] something concrete",
		"",
	].join("\n");

	test("the no-estimate set is NON-EMPTY and matches the floor's basis", () => {
		const graph = buildAtlasFromFile(LINKED, "linked.md");
		const cp = computeCriticalPath(graph);
		if (!cp.ok) throw new Error("expected a computed result");
		// P-3 is connected by a dependency and has no effort line.
		expect(cp.unestimatedIdentifiers).toEqual(["P-3"]);
		expect(embedded(renderAtlasHtml(graph), "NOEST_IDS")).toEqual(["P-3"]);
	});

	test("the no-estimate set is the SAME set the floor's lower bound rests on", () => {
		// Two derivations disagreed one commit apart: the tooltip counted expanded
		// connected leaves, the filter counted literal edge endpoints. After an epic
		// edge expanded, the stories making the floor a bound were invisible to the
		// filter the tooltip named.
		const graph = buildAtlasFromFile(FILE, "x.md");
		const cp = computeCriticalPath(graph);
		expect(embedded(renderAtlasHtml(graph), "NOEST_IDS")).toEqual(
			cp.ok ? cp.unestimatedIdentifiers : [],
		);
	});

	test("the browser CONSUMES that set rather than re-deriving it", () => {
		const out = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(out).toContain("const want=new Set(NOEST_IDS||[]);");
		// The old re-derivation must not come back.
		expect(out).not.toContain("if(onEdge.has(n.id))NOEST.add(n.id);");
	});

	test("the gauge distinguishes all four states", () => {
		const out = renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"));
		expect(out).toContain('if(st==="ok")');
		expect(out).toContain('st==="cycle"');
		expect(out).toContain('st==="incomplete"');
		expect(out).toContain("No dependency chain on this board");
	});
});
