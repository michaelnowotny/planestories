import { Marked } from "marked";
import TurndownService from "turndown";

/**
 * A marked instance whose list rendering emits Plane's TipTap **task-list**
 * schema (`<ul data-type="taskList"><li data-type="taskItem" data-checked>…`)
 * instead of GFM `<input type="checkbox">`. Plane's editor only renders an
 * interactive checklist from the TipTap shape, so acceptance criteria written as
 * `- [ ]` / `- [x]` become native, tickable checkboxes in the work item
 * description (and round-trip back via `htmlToMarkdown`).
 *
 * The override is token-level (not a string/regex post-pass) so nested lists,
 * loose/multi-paragraph items, and inline markup (code, links, emphasis) are all
 * rendered by marked itself. A list mixing task and plain items is SPLIT into
 * consecutive same-kind lists, so a checkbox authored next to a plain bullet
 * still renders as a native task item.
 */
const taskListMarked = new Marked({
	renderer: {
		listitem(item) {
			if (item.task) {
				// item.tokens is the content WITHOUT the `[ ]` marker (marked strips it
				// into item.task/item.checked). Loose items already produce block HTML;
				// tight items produce inline HTML we wrap in a <p> (TipTap taskItem shape).
				const content = item.loose
					? this.parser.parse(item.tokens, true)
					: `<p>${this.parser.parseInline(item.tokens)}</p>`;
				const checked = item.checked ? "true" : "false";
				return `<li class="todo-list-item" data-type="taskItem" data-checked="${checked}">${content}</li>\n`;
			}
			const content = item.loose
				? this.parser.parse(item.tokens, item.loose)
				: this.parser.parseInline(item.tokens);
			return `<li>${content}</li>\n`;
		},
		list(token) {
			if (token.ordered) {
				const startAttr =
					typeof token.start === "number" && token.start !== 1 ? ` start="${token.start}"` : "";
				let items = "";
				for (const item of token.items) {
					items += this.listitem(item);
				}
				return `<ol${startAttr}>\n${items}</ol>\n`;
			}
			// Unordered: split consecutive task-item / plain-item runs so a mixed
			// list yields a native taskList for the checkboxes and a plain <ul> for
			// the rest (Codex #5 — an adjacent plain bullet must not de-nativize the
			// checkboxes).
			let html = "";
			let run: string[] = [];
			let runIsTask: boolean | null = null;
			const flush = () => {
				if (run.length === 0) {
					return;
				}
				const open = runIsTask ? '<ul class="todo-list" data-type="taskList">\n' : "<ul>\n";
				html += `${open}${run.join("")}</ul>\n`;
				run = [];
			};
			for (const item of token.items) {
				const isTask = Boolean(item.task);
				if (runIsTask !== null && isTask !== runIsTask) {
					flush();
				}
				runIsTask = isTask;
				run.push(this.listitem(item));
			}
			flush();
			return html;
		},
	},
});

/**
 * Convert a story's markdown body into HTML for Plane's `description_html`.
 *
 * Plane stores rich text as HTML (unlike Linear, which accepts markdown
 * directly), so we render once at import time. Acceptance-criteria checkboxes
 * become a native TipTap task-list (see `taskListMarked`). Returns an empty
 * string for empty input so callers can skip the field entirely.
 */
export function markdownToHtml(markdown: string): string {
	const trimmed = markdown.trim();
	if (!trimmed) {
		return "";
	}
	return taskListMarked.parse(trimmed, { async: false }) as string;
}

/** Does this stored `description_html` already contain a TipTap task-list? */
export function hasDescriptionChecklist(html: string | undefined | null): boolean {
	return typeof html === "string" && html.includes('data-type="taskList"');
}

/** Minimal DOM-ish node shape exposed by Turndown's bundled parser. */
interface TurndownNode {
	nodeName?: string;
	getAttribute?(name: string): string | null;
	parentNode?: TurndownNode | null;
}

/** True if `node` is (or descends from) a TipTap taskItem `<li>`. */
function insideTaskItem(node: TurndownNode): boolean {
	let parent: TurndownNode | null | undefined = node.parentNode;
	while (parent) {
		if (parent.nodeName === "LI" && parent.getAttribute?.("data-type") === "taskItem") {
			return true;
		}
		parent = parent.parentNode;
	}
	return false;
}

/** True if a legacy GFM checkbox <input> is in the checked state. */
function isInputChecked(node: TurndownNode): boolean {
	return node.getAttribute?.("checked") !== null && node.getAttribute?.("checked") !== undefined;
}

function buildTurndown(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});

	// Plane's TipTap task list: `<li data-type="taskItem" data-checked="true|false">`
	// with NO <input> — the checked state lives on the <li>. Emit `- [x]`/`- [ ]`
	// from the CONVERTED child markdown (so inline code/links/emphasis survive), NOT
	// textContent. This is the reader half of the board→file reverse sync.
	service.addRule("tiptapTaskItem", {
		filter: (node) =>
			node.nodeName === "LI" &&
			(node as unknown as TurndownNode).getAttribute?.("data-type") === "taskItem",
		replacement: (content, node) => {
			const checked =
				(node as unknown as TurndownNode).getAttribute?.("data-checked") === "true";
			const text = content
				.replace(/^\n+/, "")
				.replace(/\n+$/, "")
				.replace(/\n/g, " ")
				// Defensive: strip a leading `[x]`/`[ ]` a nested <input> might have left
				// (the INPUT rule is ancestor-gated below, so this is belt-and-suspenders).
				.replace(/^\[[ xX]\]\s+/, "")
				.trim();
			const marker = checked ? "[x]" : "[ ]";
			const sep = (node as unknown as { nextSibling?: unknown }).nextSibling ? "\n" : "";
			return `- ${marker} ${text}${sep}`;
		},
	});

	// Legacy GFM `<input type=checkbox>` (e.g. from an old export or non-Plane
	// HTML). Ancestor-gated so it does NOT also fire inside a TipTap taskItem —
	// otherwise a hybrid `<li data-type=taskItem><input>` would double-mark
	// (`- [x] [x] …`) (Grok F5 / Codex #7).
	service.addRule("gfmTaskCheckbox", {
		filter: (node) =>
			node.nodeName === "INPUT" &&
			(node as unknown as { type?: string }).type === "checkbox" &&
			!insideTaskItem(node as unknown as TurndownNode),
		replacement: (_content, node) =>
			`${isInputChecked(node as unknown as TurndownNode) ? "[x]" : "[ ]"} `,
	});

	return service;
}

const turndown = buildTurndown();

/**
 * Convert Plane's stored `description_html` back into markdown for export.
 *
 * Recovers headings and task-list checkboxes — from BOTH Plane's TipTap
 * `data-type="taskItem"` shape and legacy GFM `<input>` — so an exported story
 * can be re-imported without losing its `### Acceptance Criteria` checklist or
 * its checked state. Returns an empty string for empty input.
 */
export function htmlToMarkdown(html: string | undefined | null): string {
	if (!html || !html.trim()) {
		return "";
	}
	return (
		turndown
			.turndown(html)
			// Turndown pads list markers ("-   [ ]  text"); normalize legacy GFM
			// task-list items back to canonical "- [ ] text" / "- [x] text". (The
			// TipTap rule already emits the canonical form.)
			.replace(/^[-*]\s+(\[[ xX]\])\s+/gm, (_match, box: string) => `- ${box.toLowerCase()} `)
			.trim()
	);
}
