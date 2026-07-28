/**
 * Body-line "directive" conventions — human-writable, agent-parseable metadata
 * that lives as bold-label lines in a story's markdown body rather than in the
 * fenced YAML block. Today: effort and dependency input sugar.
 *
 *   **Effort:** 2.5 dev-days
 *
 * These stay first-class in the body (that is where the team keeps them as the
 * source of truth), so they round-trip through the Plane description for free —
 * no separate hash field, no separate board storage. The parsed value is exposed
 * as a field only for downstream consumers (lint, epic rollup).
 *
 * Detection is deliberately NARROW so it cannot silently corrupt the content
 * hash: an effort line is recognized only in the NARRATIVE — the exact region
 * `splitBody` (the criteria splitter that feeds the hash and the --sync-criteria
 * parent body) considers narrative — and never inside a fenced code block.
 *
 */

import { acHeadingIndex, splitBody } from "./criteria.ts";
import { htmlToMarkdown, markdownToHtml } from "./html.ts";

// Single line, case-insensitive. NOT global — kept stateless so the same literal
// is safe for repeated `.match()`. The unit separator is space/tab/hyphen only
// (NOT `\s`, which would let "dev\ndays" span a line break). Accepts
// dev-day/dev-days/dev day/dev days/devdays; the trailing `.*` tolerates a suffix.
const EFFORT_LINE = /^[ \t]*\*\*effort:\*\*[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*dev[ \t-]?days?\b.*$/i;

// An effort-directive marker appearing ANYWHERE (not line-anchored) — either bold
// form. Used only as an anti-duplicate guard: if the body mentions effort text at
// all (even mid-line, e.g. inside a raw `<pre>` block, or in prose), we decline to
// inject a second line. Deliberately conservative — a false "mention" just means
// no YAML injection (lint then flags "missing effort"), never a fabricated duplicate.
const EFFORT_MENTION = /(?:\*\*|__)effort:(?:\*\*|__)/i;

// A code-fence line: 0-3 spaces of indentation (CommonMark; 4+ spaces or a tab is
// indented code, not a fence), then a run of >=3 backticks or tildes, then an
// optional info string. Groups: (1) the fence run, (2) the trailing text.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// A story estimated above this many developer-days is nonsense; the bound also
// rejects magnitudes that lose precision as a JS number (e.g. a 16-digit string).
const MAX_EFFORT_DAYS = 100_000;

/**
 * Per-line mask: true when the line sits inside (or delimits) a fenced code
 * block, following CommonMark fence rules that matter for correctness here:
 *  - a fence is opened with >=3 backticks or >=3 tildes;
 *  - it is closed only by a fence of the SAME character, AT LEAST AS LONG as the
 *    opener, and with NO info string. So a ``` line inside a ```` block, or a
 *    `~~~` inside a ``` block, is content, not a delimiter.
 */
export function fenceMask(lines: string[]): boolean[] {
	const mask = new Array<boolean>(lines.length).fill(false);
	let open: { char: string; length: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const match = (lines[i] as string).match(FENCE);
		if (match) {
			const run = match[1] as string;
			const info = (match[2] as string).trim();
			if (open === null) {
				open = { char: run[0] as string, length: run.length }; // opening fence
			} else if (run[0] === open.char && run.length >= open.length && info === "") {
				open = null; // valid closing fence
			}
			// Any other fence line while open is content — still fenced.
			mask[i] = true;
			continue;
		}
		mask[i] = open !== null;
	}
	return mask;
}

const DEPENDENCY_LINE = /^ {0,3}(\*\*|__)(depends on|blocks):\1[ \t]*(.*?)[ \t]*$/i;

/**
 * Normalize Plane identifiers for deterministic hashing and serialization.
 * Plane identifiers are case-insensitive in markdown input but canonical on the
 * board, so store them uppercased, deduplicated, and sorted.
 */
export function normalizeRelationIdentifiers(values: Iterable<string>): string[] {
	const identifiers = new Set<string>();
	for (const value of values) {
		const identifier = value.trim().toUpperCase();
		if (identifier) {
			identifiers.add(identifier);
		}
	}
	return [...identifiers].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Parse a YAML list or comma-separated dependency field. */
export function parseRelationIdentifiers(value: unknown): string[] {
	if (Array.isArray(value)) {
		return normalizeRelationIdentifiers(value.map(String));
	}
	if (typeof value === "string" && value.trim()) {
		return normalizeRelationIdentifiers(value.split(","));
	}
	return [];
}

export interface ParsedDependencyDirectives {
	body: string;
	blockedBy: string[];
	blocks: string[];
}

/**
 * Extract dependency body-line input sugar and remove recognized lines from the
 * description. Directives are line-anchored bold labels and are ignored inside
 * fenced code blocks.
 */
export function extractDependencyDirectives(body: string): ParsedDependencyDirectives {
	const lines = body.split("\n");
	const mask = fenceMask(lines);
	const kept: string[] = [];
	const blockedBy: string[] = [];
	const blocks: string[] = [];
	let found = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const match = mask[i] ? null : line.match(DEPENDENCY_LINE);
		if (!match) {
			kept.push(line);
			continue;
		}
		found = true;
		const values = parseRelationIdentifiers(match[3]);
		if ((match[2] as string).toLowerCase() === "depends on") {
			blockedBy.push(...values);
		} else {
			blocks.push(...values);
		}
	}

	return {
		body: found ? kept.join("\n").trim() : body,
		blockedBy: normalizeRelationIdentifiers(blockedBy),
		blocks: normalizeRelationIdentifiers(blocks),
	};
}

/**
 * Index where the narrative ends: the Acceptance-Criteria heading, located the
 * SAME way `splitBody` locates it (ATX or Setext, via the shared `acHeadingIndex`),
 * so injection places the effort line inside the same narrative the hash uses.
 * `lines.length` when there is no heading.
 */
function narrativeBoundary(lines: string[]): number {
	const index = acHeadingIndex(lines);
	return index === -1 ? lines.length : index;
}

/**
 * Extract the dev-day effort from a story body, or null when absent/unparseable.
 *
 * The scan region is EXACTLY `splitBody(body).narrative` — the same region the
 * content hash and the `--sync-criteria` parent body use — so effort detection
 * can never disagree with what gets hashed/stored. Within it we detect on the
 * CANONICAL form (`htmlToMarkdown(markdownToHtml(...))`, the transform the Plane
 * description round-trips through), letting `marked` (a real CommonMark engine)
 * normalize indented code / raw-HTML / odd fence nesting to standard ``` fences
 * or escaped text; we then only skip those standard fences. So a line that isn't
 * a genuine narrative directive (it's code) is never read as effort.
 */
export function parseEffortDays(body: string): number | null {
	const canonical = htmlToMarkdown(markdownToHtml(splitBody(body).narrative));
	const lines = canonical.split("\n");
	const mask = fenceMask(lines);
	for (let i = 0; i < lines.length; i++) {
		if (mask[i]) {
			continue; // never read effort out of a code fence
		}
		const match = (lines[i] as string).match(EFFORT_LINE);
		if (match) {
			const value = Number(match[1]);
			return Number.isFinite(value) ? value : null;
		}
	}
	return null;
}

/** True when the narrative already carries a recognizable `**Effort:**` line. */
export function hasEffortLine(body: string): boolean {
	return parseEffortDays(body) !== null;
}

/**
 * True when the body mentions effort text ANYWHERE — checked against BOTH the raw
 * body AND its canonical form, matching a marker mid-line as well as at line start.
 * The canonical pass catches equivalent Markdown (`__Effort:__` -> `**Effort:**`);
 * the raw pass catches effort text the HTML round-trip escapes/hides (e.g. a
 * same-line `<pre>**Effort:** ...</pre>`, where Turndown escapes the markers). Any
 * hit makes the parser refuse to inject, so a YAML `effort_days:` can never
 * fabricate a duplicate `**Effort:**` occurrence.
 */
export function hasAnyEffortMention(body: string): boolean {
	return EFFORT_MENTION.test(body) || EFFORT_MENTION.test(htmlToMarkdown(markdownToHtml(body)));
}

/**
 * Render a dev-day count canonically (no trailing zeros, NO exponent): 2.5, 2,
 * 0.5, 0.0000001. `String()` uses exponent form for small magnitudes (1e-7),
 * which the effort grammar rejects — `toFixed` keeps a plain decimal.
 */
export function formatDevDays(value: number): string {
	let str = value.toFixed(10);
	if (str.includes(".")) {
		str = str.replace(/0+$/, "").replace(/\.$/, "");
	}
	return str;
}

/**
 * Coerce a YAML `effort_days:` value strictly. Accepts a finite, non-negative
 * number (or unsigned-decimal string) whose canonical rendering re-parses to the
 * same value — so it can never fabricate a value (e.g. `false`/`" "` -> 0) or
 * materialize a line the effort grammar could not read back (`-1`, `.inf`, a
 * magnitude `toFixed` cannot represent exactly). Everything else is null.
 */
export function parseYamlEffort(value: unknown): number | null {
	let candidate: number;
	if (typeof value === "number") {
		candidate = value;
	} else if (typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value.trim())) {
		candidate = Number(value.trim());
	} else {
		return null;
	}
	if (!Number.isFinite(candidate) || candidate < 0 || candidate > MAX_EFFORT_DAYS) {
		return null;
	}
	// Must survive canonical render -> re-parse exactly (rejects exponent-only /
	// sub-precision magnitudes that would break the parse->inject fixed point).
	const rendered = formatDevDays(candidate);
	if (!/^[0-9]+(?:\.[0-9]+)?$/.test(rendered) || Number(rendered) !== candidate) {
		return null;
	}
	// For a string input, the canonical rendering must equal the input exactly, so a
	// precision-losing value (e.g. "9007199254740993" -> 9007199254740992) is rejected
	// rather than silently altered. Trailing-zero forms (2.50) are normalized by the
	// number path, not here (a bare "2.50" string is uncommon and safely rejected).
	if (typeof value === "string" && rendered !== value.trim()) {
		return null;
	}
	return candidate;
}

/**
 * Materialize a canonical `**Effort:** N dev-days` line into a body whose
 * narrative lacks one. Inserted at the narrative boundary (before the AC
 * heading) so it is part of the hashed/parent narrative, else appended. A body
 * whose narrative already has an effort line is returned unchanged.
 *
 * Callers should verify the result actually re-parses (see the parser's
 * self-check) — a pathological body (e.g. an unclosed code fence) can leave the
 * appended line fenced, in which case the injection must be rejected.
 */
export function injectEffortLine(body: string, effortDays: number): string {
	if (hasEffortLine(body)) {
		return body;
	}
	const line = `**Effort:** ${formatDevDays(effortDays)} dev-days`;
	const lines = body.split("\n");
	const boundary = narrativeBoundary(lines);

	if (boundary === lines.length) {
		const trimmed = body.trim();
		return trimmed ? `${trimmed}\n\n${line}` : line;
	}

	const before = lines.slice(0, boundary).join("\n").trim();
	const after = lines.slice(boundary).join("\n").trim();
	const head = before ? `${before}\n\n${line}` : line;
	return `${head}\n\n${after}`;
}
