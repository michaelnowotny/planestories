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

/** Coverage is required, so every render site states it. A file graph is complete. */
function renderAtlas(): string {
	return renderAtlasHtml(buildAtlasFromFile(FILE, "x.md"), {
		coverage: { kind: "complete" },
		provenance: null,
	});
}

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

/**
 * Names bound anywhere in the script.
 *
 * Scope is deliberately ignored — the question is "does anything declare this at
 * all", and a name declared in the wrong scope is a different bug from a name
 * declared nowhere. Declarator lists are walked with a DEPTH COUNTER rather than
 * a regex: `for(const h of HUBS){const hp=P.get(h.id);` defeats any greedy
 * capture, which silently made four real declarations look undeclared while I
 * was writing this.
 */
function declaredNames(source: string): Set<string> {
	const declared = new Set<string>();
	const add = (name: string | undefined) => {
		if (name) declared.add(name);
	};
	for (const m of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
	for (const m of source.matchAll(/(?:function\s*[A-Za-z_$][\w$]*\s*|function\s*)\(([^)]*)\)/g)) {
		for (const p of (m[1] ?? "").split(",")) add(p.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]);
	}
	for (const m of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
		for (const p of (m[1] ?? "").split(",")) add(p.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]);
	}
	for (const m of source.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
	for (const m of source.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);

	// Declarator lists: collect the identifier after the keyword and after every
	// depth-0 comma, stopping at a depth-0 `;` or when a bracket closes past the
	// level we started at (`for(const x of y)`, `{const a=1}`).
	for (const m of source.matchAll(/\b(?:const|let|var)\s+/g)) {
		let i = (m.index ?? 0) + m[0].length;
		let depth = 0;
		let expectName = true;
		while (i < source.length) {
			const ch = source[i] as string;
			if (expectName && /[A-Za-z_$]/.test(ch)) {
				const name = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
				add(name);
				i += name?.length ?? 1;
				expectName = false;
				continue;
			}
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") {
				if (depth === 0) break;
				depth--;
			} else if (depth === 0 && ch === ";") break;
			else if (depth === 0 && ch === ",") expectName = true;
			i++;
		}
	}
	return declared;
}

describe("embedded script integrity", () => {
	test("every function the script calls is defined somewhere in it", () => {
		const source = stripNonCode(embeddedScript(renderAtlas()));
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

	test("nothing is ASSIGNED that was never declared", () => {
		// The general form of the defect, and the reason a call-site sweep alone is
		// not enough: `frame()` threw on a READ of `dragScope`, which no call-site
		// check can see. Under `"use strict"` an assignment to an undeclared name
		// throws too, and module state that is read is essentially always assigned
		// somewhere — so this catches the class without needing to tell a regex
		// literal from a division, which is what defeated the fully general sweep.
		//
		// It replaces a test that named `dragScope`/`dragAlpha` literally. Naming
		// the two bindings that already bit us would not catch the third.
		const source = stripNonCode(embeddedScript(renderAtlas()));
		const declared = declaredNames(source);
		const undeclared = new Set<string>();
		for (const m of source.matchAll(
			/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:\+|-|\*|\/|\|\||&&|\?\?)?=(?![=>])/g,
		)) {
			const name = m[2];
			if (!name) continue;
			if (!declared.has(name) && !KEYWORDS.has(name) && !GLOBALS.has(name)) undeclared.add(name);
		}
		expect([...undeclared].sort()).toEqual([]);
	});

	test("dragging one node does not drag its dependency partners with it", () => {
		// The round-2 finding: scoping the simulation to a node's blockers extracted
		// them from their own clusters, so unrelated groups lurched on every drag.
		// Scope is the node's own cluster; cross-cluster springs still act on the
		// dragged node through tick()'s one-ended boundary rule.
		const source = embeddedScript(renderAtlas());
		const fn = source.match(/function neighbourhoodOf\(id\)\{[\s\S]*?\n\}/);
		expect(fn).not.toBeNull();
		expect(fn?.[0]).not.toContain("EDGES");
	});
});
