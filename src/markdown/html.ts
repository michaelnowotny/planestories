import { marked } from "marked";

/**
 * Convert a story's markdown body into HTML for Plane's `description_html`.
 *
 * Plane stores rich text as HTML (unlike Linear, which accepts markdown
 * directly), so we render once at import time. Returns an empty string for
 * empty input so callers can skip the field entirely.
 */
export function markdownToHtml(markdown: string): string {
	const trimmed = markdown.trim();
	if (!trimmed) {
		return "";
	}
	// marked.parse is synchronous when no async extensions are registered.
	return marked.parse(trimmed, { async: false }) as string;
}
