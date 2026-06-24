import { marked } from "marked";
import TurndownService from "turndown";

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

/** Minimal DOM-ish node shape exposed by Turndown's bundled parser. */
interface TurndownNode {
	getAttribute?(name: string): string | null;
	parentNode?: TurndownNode | null;
}

/** True if a checkbox <input> (or an ancestor task item) is in the checked state. */
function isChecked(node: TurndownNode): boolean {
	if (node.getAttribute?.("checked") !== null && node.getAttribute?.("checked") !== undefined) {
		return true;
	}
	let parent = node.parentNode;
	while (parent) {
		if (parent.getAttribute?.("data-checked") === "true") {
			return true;
		}
		parent = parent.parentNode;
	}
	return false;
}

function buildTurndown(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});

	// Reconstruct GFM task-list markers from checkbox inputs so that
	// `- [ ]` / `- [x]` survive an HTML round-trip (this is what makes export
	// safe to re-import — acceptance criteria stay machine-readable).
	service.addRule("taskListCheckbox", {
		filter: (node) =>
			node.nodeName === "INPUT" && (node as unknown as { type?: string }).type === "checkbox",
		replacement: (_content, node) =>
			`${isChecked(node as unknown as TurndownNode) ? "[x]" : "[ ]"} `,
	});

	return service;
}

const turndown = buildTurndown();

/**
 * Convert Plane's stored `description_html` back into markdown for export.
 *
 * Preserves headings and task-list checkboxes so that an exported story can be
 * re-imported without losing its `### Acceptance Criteria` checklist. Returns an
 * empty string for empty input.
 */
export function htmlToMarkdown(html: string | undefined | null): string {
	if (!html || !html.trim()) {
		return "";
	}
	return (
		turndown
			.turndown(html)
			// Turndown pads list markers ("-   [ ]  text"); normalize task-list
			// items back to canonical "- [ ] text" / "- [x] text".
			.replace(/^[-*]\s+(\[[ xX]\])\s+/gm, (_match, box: string) => `- ${box.toLowerCase()} `)
			.trim()
	);
}
