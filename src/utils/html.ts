/**
 * HTML-escape a string for insertion into element content OR an attribute value.
 *
 * Consolidated from four near-copies (`sync/importer.ts`, `sync/setter.ts`,
 * `replicate/apply.ts`, `atlas/render.ts`) that had drifted into two contracts:
 * three escaped `"` and one did not. No live defect — the three-character
 * version only ever reached element content, where a quote is harmless, while
 * the one used inside `data-psrepl-comment="…"` did escape it. But the weaker
 * copy was named exactly like the stronger ones, so the next person to reuse it
 * in an attribute would have had no signal, and the bug would have been an
 * attribute breakout rather than a crash.
 *
 * `&` MUST be replaced first or the subsequent replacements are double-escaped.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
