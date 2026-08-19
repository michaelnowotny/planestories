import { describe, expect, test } from "bun:test";
import { buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { renderAtlasHtml } from "../../../src/atlas/render.ts";

/**
 * The embedded script is the one part of this codebase that NO test executes:
 * it is a string here and a program only in a browser. That gap let commit
 * `c6ef04c` delete three function bodies while leaving their call sites, and the
 * suite stayed green at 761 tests. Because `frame()` is started by
 * `requestAnimationFrame` at load and reads that state on its FIRST line, the
 * result was not "dragging is broken" — under `"use strict"` the very first
 * animation frame threw and the atlas never drew anything at all.
 *
 * So: a cheap static stand-in for running it. Not a substitute for a real DOM,
 * but it catches the specific class that shipped — a reference that survives its
 * declaration.
 */

const FILE = `---
project: "P"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Done
\`\`\`

Body.
`;

/** Browser and language globals the script is entitled to use undeclared. */
const GLOBALS = new Set([
	"Error",
	"Map",
	"Math",
	"Number",
	"Object",
	"JSON",
	"Array",
	"RegExp",
	"ResizeObserver",
	"Set",
	"String",
	"Symbol",
	"alert",
	"isFinite",
	"parseFloat",
	"parseInt",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"setTimeout",
	"clearTimeout",
	"document",
	"window",
]);

const KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"function",
	"return",
	"typeof",
	"new",
	"do",
	"else",
	"await",
	"of",
	"in",
	"delete",
	"void",
	"instanceof",
]);

/** The page's own program: the longest inline `<script>`. */
function embeddedScript(html: string): string {
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
		.map((m) => m[1])
		.filter((s): s is string => typeof s === "string")
		.sort((a, b) => b.length - a.length);
	const longest = scripts[0];
	expect(longest).toBeDefined();
	return longest as string;
}

/**
 * Comments and literals are removed first, so a word inside a colour string or a
 * tooltip sentence is never mistaken for code.
 */
function stripNonCode(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
		.replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, '""')
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function declaredNames(source: string): Set<string> {
	const declared = new Set<string>();
	for (const m of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) {
		if (m[1]) declared.add(m[1]);
	}
	// `let a=1,b=2` — every declarator in the statement, not just the first, so the
	// match must run PAST the first `=`. A part whose text does not begin with an
	// identifier (the tail of a split-up call argument) simply contributes nothing.
	for (const m of source.matchAll(/\b(?:const|let|var)\s+([^;\n]*)/g)) {
		for (const part of (m[1] ?? "").split(",")) {
			const name = part.trim().match(/^([A-Za-z_$][\w$]*)/);
			if (name?.[1]) declared.add(name[1]);
		}
	}
	return declared;
}

describe("embedded script integrity", () => {
	test("every function the script calls is defined somewhere in it", () => {
		const source = stripNonCode(embeddedScript(renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"))));
		const declared = declaredNames(source);

		const missing = new Set<string>();
		for (const m of source.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
			const name = m[2];
			if (!name) continue;
			if (!declared.has(name) && !KEYWORDS.has(name) && !GLOBALS.has(name)) missing.add(name);
		}

		// Naming them makes the failure self-explanatory instead of a bare count.
		expect([...missing].sort()).toEqual([]);
	});

	test("the drag-relaxation state the frame loop reads is declared", () => {
		// `frame()` reads `dragScope` on its first line and is started at load, so an
		// undeclared name here is not a degraded feature — under strict mode it is a
		// blank page. A call-site sweep cannot see this one: it is a READ, not a call.
		const source = stripNonCode(embeddedScript(renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"))));
		const declared = declaredNames(source);
		for (const name of ["dragScope", "dragAlpha"]) {
			expect(declared.has(name)).toBe(true);
		}
	});

	test("dragging one node does not drag its dependency partners with it", () => {
		// The round-2 finding: scoping the simulation to a node's blockers extracted
		// them from their own clusters, so unrelated groups lurched on every drag.
		// Scope is the node's own cluster; cross-cluster springs still act on the
		// dragged node through tick()'s one-ended boundary rule.
		const source = embeddedScript(renderAtlasHtml(buildAtlasFromFile(FILE, "x.md")));
		const fn = source.match(/function neighbourhoodOf\(id\)\{[\s\S]*?\n\}/);
		expect(fn).not.toBeNull();
		expect(fn?.[0]).not.toContain("EDGES");
	});
});
