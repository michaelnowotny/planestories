import { ParseError } from "../errors.ts";

export interface AcceptanceCriterion {
	text: string;
	checked: boolean;
}

export interface SplitBody {
	/** Body content before the "### Acceptance Criteria" heading. */
	narrative: string;
	/** Parsed checkbox criteria from the acceptance-criteria section. */
	criteria: AcceptanceCriterion[];
	/** Whether an acceptance-criteria heading was present. */
	hasHeading: boolean;
	/**
	 * Body content from the next heading after the criteria block onward (or ""
	 * when the criteria block runs to end-of-file). This is the load-bearing field
	 * that lets a rebuild preserve trailing content instead of silently dropping
	 * it. See `spliceAcceptanceCriteria`.
	 */
	suffix: string;
}

interface CriterionBlock {
	criterion: AcceptanceCriterion;
	/** Raw indented/blank lines structurally owned by this top-level criterion. */
	nestedLines: string[];
}

interface ParsedBody extends SplitBody {
	criterionBlocks: CriterionBlock[];
	/** Unindented non-checkbox content inside the AC section. */
	extras: string;
}

/**
 * The Acceptance-Criteria heading. Exported so effort detection (directives.ts)
 * scans exactly the same narrative region this splitter uses — otherwise the two
 * could disagree on where the narrative ends and effort could be hashed
 * inconsistently under `--sync-criteria`.
 */
export const AC_HEADING = /^#{1,6}\s+acceptance criteria\s*#*\s*$/i;
/**
 * A checklist line, split into (prefix)(mark)(rest) so the mark can be rewritten
 * in place while preserving the exact bullet, indentation and text. The prefix
 * DELIBERATELY captures leading whitespace: a criterion list may legally be
 * indented, and dropping that indentation on write-back would reflow the file.
 *
 * Whether a given checkbox is a peer criterion or nested content is NOT decided
 * by this pattern — it cannot be. It is decided by comparing indentation against
 * the first checkbox in the section (`baseIndentOf`), because both readings of a
 * two-space checkbox are correct depending on what precedes it. An earlier
 * version treated ANY leading whitespace as nested, which rejected
 * CommonMark-legal top-level lists — one to three leading spaces — and told the
 * author to use a top-level criterion, which it already was.
 *
 * This remains the ONE source of truth used by `splitBody` and write-back
 * numbering, so their positions cannot drift.
 */
export const CHECKBOX_LINE = /^([\t ]*[-*]\s+)\[([ xX])\](\s+.*)$/;

/**
 * The indices of lines that are PEER acceptance criteria, within an already
 * isolated criteria section.
 *
 * THE shared classifier. `splitBody` decides peer-vs-nested while parsing;
 * `groom --write-back` has to make the identical decision when it numbers
 * checkboxes to tick, and it was making a different one — it counted every
 * matching line. So `::ac1` could tick a checkbox nested under a bullet instead
 * of the second real criterion, writing the wrong state onto someone's board.
 *
 * Widening CHECKBOX_LINE to accept legally-indented lists made that worse:
 * indented checkboxes previously did not match at all, so write-back skipped
 * them by accident. Two callers deciding the same thing separately is what this
 * exists to stop.
 */
export function peerCheckboxLineIndices(lines: readonly string[]): number[] {
	const fenced = markdownFenceMask([...lines]);
	const peers: number[] = [];
	// A STACK of open list-item content columns, not a single value. Keeping only
	// the latest marker meant a deeper sibling overwrote its parent's column:
	//
	//   - category            content column 2
	//     - subcategory       overwrote it with 4
	//     - [ ] nested task   indent 2 < 4, so wrongly promoted to a peer
	//
	// and `--sync-criteria` would then create that nested task as a work item.
	const open: number[] = [];
	for (const [i, line] of lines.entries()) {
		if (fenced[i]) continue;
		const marker = /^([\t ]*)([-*+]|\d+[.)])(\s+)/.exec(line);
		if (!marker) {
			// A non-list line CLOSES any container it has outdented past — a
			// paragraph at column 0 ends the list above it. Without this the stack
			// kept stale containers, so a later legal top-level checklist was read
			// as nested inside a list that had already ended. Indented continuation
			// lines pop nothing, which is what keeps a criterion's detail lines
			// attached to it.
			if (line.trim() !== "") {
				const textIndent = indentWidth(line);
				while (open.length > 0 && (open.at(-1) as number) > textIndent) open.pop();
			}
			continue;
		}
		const indent = indentWidth(marker[1] ?? "");
		// Close every container this line has outdented past.
		while (open.length > 0 && (open.at(-1) as number) > indent) open.pop();
		const inside = open.length > 0 && indent >= (open.at(-1) as number);
		const checkbox = line.match(CHECKBOX_LINE);
		if (checkbox) {
			if (inside) {
				// SKIPPING would renumber: write-back's `::ac1` would then mean a
				// different criterion than `splitBody` produced, and groom would
				// happily tick a box on a file that import refuses. Both paths must
				// reach the same verdict, so both refuse.
				throw new ParseError(
					`Acceptance Criteria nested checkbox "${(checkbox[3] ?? "").trim()}" ` +
						"cannot round-trip without flattening; use an ordinary nested bullet, or outdent it to a top-level criterion",
				);
			}
			peers.push(i);
		}
		open.push(contentColumn(marker) as number);
	}
	return peers;
}

/** CommonMark content column of a list item: marker indent + marker + following spaces. */
function contentColumn(marker: RegExpExecArray | null): number | null {
	if (!marker) return null;
	// indent + marker + the spaces after it. `- x` at column 0 has content at 2.
	return indentWidth(marker[1] ?? "") + (marker[2] ?? "").length + (marker[3] ?? "").length;
}

/** Visual width of a line's leading whitespace, with tabs as four columns. */
function indentWidth(line: string): number {
	const lead = /^[\t ]*/.exec(line)?.[0] ?? "";
	return [...lead].reduce((n, ch) => n + (ch === "\t" ? 4 : 1), 0);
}
const ANY_HEADING = /^#{1,6}\s+/;
const AC_TEXT = /^acceptance criteria$/i;
const SETEXT_UNDERLINE = /^(?:=+|-+)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function acHeadingLength(lines: string[], index: number): 0 | 1 | 2 {
	const trimmed = (lines[index] ?? "").trim();
	if (AC_HEADING.test(trimmed)) {
		return 1;
	}
	if (
		AC_TEXT.test(trimmed) &&
		index + 1 < lines.length &&
		SETEXT_UNDERLINE.test((lines[index + 1] ?? "").trim())
	) {
		return 2;
	}
	return 0;
}

/** Lines inside (or delimiting) a CommonMark fenced code block. */
function markdownFenceMask(lines: string[]): boolean[] {
	const mask = new Array<boolean>(lines.length).fill(false);
	let open: { char: string; length: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const match = (lines[i] as string).match(FENCE);
		if (match) {
			const run = match[1] as string;
			const info = (match[2] as string).trim();
			if (open === null) {
				open = { char: run[0] as string, length: run.length };
			} else if (run[0] === open.char && run.length >= open.length && info === "") {
				open = null;
			}
			mask[i] = true;
			continue;
		}
		mask[i] = open !== null;
	}
	return mask;
}

/** Trim only empty boundary lines; never strip indentation from real content. */
function trimBoundaryBlankLines(lines: string[]): string {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") {
		start++;
	}
	while (end > start && (lines[end - 1] ?? "").trim() === "") {
		end--;
	}
	return lines.slice(start, end).join("\n");
}

/**
 * Index of the Acceptance-Criteria heading, or -1. Recognizes an ATX heading
 * (`### Acceptance Criteria`, closing `#`s tolerated) AND a Setext heading
 * (`Acceptance Criteria` on one line, `===`/`---` underline on the next). The
 * Setext form matters because Plane's HTML round-trip normalizes it to ATX; if
 * this splitter recognized only ATX, the narrative boundary (and any field
 * derived from it, like effort) would shift across the round-trip. Fenced-code
 * examples are ignored. Returns the index of the heading (the TEXT line for a
 * Setext heading).
 */
export function acHeadingIndex(lines: string[]): number {
	const fenced = markdownFenceMask(lines);
	for (let i = 0; i < lines.length; i++) {
		if (!fenced[i] && acHeadingLength(lines, i) > 0) {
			return i;
		}
	}
	return -1;
}

/** Parse the one permitted AC section, retaining nested blocks for a lossless splice. */
function parseBody(body: string): ParsedBody {
	const lines = body.split("\n");
	const headingIndex = acHeadingIndex(lines);

	if (headingIndex === -1) {
		return {
			narrative: body.trim(),
			criteria: [],
			hasHeading: false,
			suffix: "",
			criterionBlocks: [],
			extras: "",
		};
	}

	const firstHeadingLength = acHeadingLength(lines, headingIndex);
	const fenced = markdownFenceMask(lines);
	for (let i = headingIndex + firstHeadingLength; i < lines.length; i++) {
		const duplicateLength = acHeadingLength(lines, i);
		if (!fenced[i] && duplicateLength > 0) {
			throw new ParseError(
				`Duplicate Acceptance Criteria heading at line ${i + 1}; a story may contain only one`,
			);
		}
	}

	const narrative = lines.slice(0, headingIndex).join("\n").trim();
	const criterionBlocks: CriterionBlock[] = [];
	const extras: string[] = [];
	let currentBlock: CriterionBlock | null = null;
	// THE shared classifier decides which checkboxes are criteria. This used to
	// re-derive it inline, and the two drifted: `groom --write-back` and this
	// parser disagreed on a two-level nested list, so a nested task became a
	// criterion here while write-back numbered around it.
	const acStart = headingIndex + firstHeadingLength;
	// Stop at the NEXT heading before classifying. Classifying everything after
	// the AC heading meant a nested checkbox in a later section — an ordinary
	// `### Testing Notes` with a sub-list — was read as a nested acceptance
	// criterion and refused the whole story.
	const acFence = markdownFenceMask(lines);
	let acEnd = lines.length;
	for (let i = acStart; i < lines.length; i++) {
		if (!acFence[i] && ANY_HEADING.test((lines[i] as string).trim())) {
			acEnd = i;
			break;
		}
	}
	const peerLines = new Set(
		peerCheckboxLineIndices(lines.slice(acStart, acEnd)).map((rel) => acStart + rel),
	);
	let suffixStart = lines.length;
	for (let i = headingIndex + firstHeadingLength; i < lines.length; i++) {
		const line = lines[i] as string;
		if (ANY_HEADING.test(line.trim())) {
			suffixStart = i;
			break;
		}

		// Any list marker — checkbox or plain bullet — opens a container. Track the
		// SHALLOWEST one still open, so a peer checkbox closes a deeper container
		// rather than inheriting it.
		const checkbox = peerLines.has(i) ? line.match(CHECKBOX_LINE) : null;
		if (checkbox) {
			// The FIRST checkbox in the section sets the peer level. Anything deeper
			// is nested content of the criterion above it — which cannot round-trip
			// through Plane's task list without being flattened into a peer, so it
			// is refused rather than silently changing what the criteria ARE.
			//
			// Comparing against the base rather than against zero is what makes a
			// legally-indented list (CommonMark allows one to three leading spaces)
			// parse as the top-level list it is, while still catching a genuine
			// child two spaces under an unindented parent. Both are two spaces; only
			// the context distinguishes them.
			const block: CriterionBlock = {
				criterion: {
					checked: checkbox[2]?.toLowerCase() === "x",
					text: (checkbox[3] ?? "").trim(),
				},
				nestedLines: [],
			};
			criterionBlocks.push(block);
			currentBlock = block;
			continue;
		}

		if (currentBlock && (line.trim() === "" || /^[\t ]+\S/.test(line))) {
			currentBlock.nestedLines.push(line);
			continue;
		}

		// Unindented prose/directives in an AC section are not criteria. Preserve
		// them separately rather than guessing which checkbox owns them.
		currentBlock = null;
		extras.push(line);
	}

	return {
		narrative,
		criteria: criterionBlocks.map((block) => block.criterion),
		hasHeading: true,
		suffix: trimBoundaryBlankLines(lines.slice(suffixStart)),
		criterionBlocks,
		extras: trimBoundaryBlankLines(extras),
	};
}

/**
 * Split a story body into its narrative and its acceptance-criteria checklist.
 *
 * An acceptance-criteria section starts at an Acceptance-Criteria heading (ATX
 * or Setext; see `acHeadingIndex`) and runs until the next heading or end of file.
 * A second such heading is malformed and refused: several other readers expose
 * only one AC section, so accepting duplicates here would make them disagree.
 * Only top-level checkbox lines are criteria. Indented detail bullets stay with
 * their parent during a splice; nested checkboxes are refused because the Plane
 * HTML conversion cannot preserve their hierarchy.
 */
export function splitBody(body: string): SplitBody {
	const { criterionBlocks: _criterionBlocks, extras: _extras, ...split } = parseBody(body);
	return split;
}

/**
 * Rebuild a story body with a REPLACED acceptance-criteria checklist, preserving
 * the narrative prefix AND every trailing section after the criteria block.
 *
 * This is the safe replacement for `joinBody(splitBody(body).narrative, block)`,
 * which dropped the suffix (`### Testing Notes`, `**Effort:**`, `**Depends on:**`,
 * …). When the body has no acceptance-criteria heading, the block is appended.
 * Passing an empty `criteria` removes the criteria block while keeping prefix and
 * suffix. Non-checkbox free text interleaved among the checkboxes inside the AC
 * block is retained as suffix content. Indented detail lines remain with the
 * criterion whose text they qualify; nested checkboxes are refused. If replacing
 * the checklist removes or renames a criterion that owns nested content, the splice
 * refuses rather than silently dropping or attaching that content to a guess.
 */
export function spliceAcceptanceCriteria(body: string, criteria: AcceptanceCriterion[]): string {
	const parsed = parseBody(body);
	if (!parsed.hasHeading) {
		// No acceptance-criteria section: append the new block after the whole body.
		return joinBodyParts([body, buildAcceptanceCriteria(criteria)]);
	}

	const nestedLines = matchNestedLines(parsed.criterionBlocks, criteria);
	const block = buildAcceptanceCriteriaWithNestedLines(criteria, nestedLines);
	return joinBodyParts([parsed.narrative, block, parsed.extras, parsed.suffix]);
}

function matchNestedLines(
	oldBlocks: CriterionBlock[],
	criteria: AcceptanceCriterion[],
): string[][] {
	const blocksByText = new Map<string, CriterionBlock[]>();
	for (const block of oldBlocks) {
		const matches = blocksByText.get(block.criterion.text) ?? [];
		matches.push(block);
		blocksByText.set(block.criterion.text, matches);
	}

	const used = new Set<CriterionBlock>();
	const nestedLines = criteria.map((criterion) => {
		const match = blocksByText.get(criterion.text)?.find((block) => !used.has(block));
		if (!match) {
			return [];
		}
		used.add(match);
		return match.nestedLines;
	});

	const orphaned = oldBlocks.find(
		(block) => !used.has(block) && block.nestedLines.some((line) => line.trim() !== ""),
	);
	if (orphaned) {
		throw new ParseError(
			`Cannot replace acceptance criterion "${orphaned.criterion.text}": its nested content ` +
				"has no matching criterion",
		);
	}

	return nestedLines;
}

function buildAcceptanceCriteriaWithNestedLines(
	criteria: AcceptanceCriterion[],
	nestedLines: string[][],
): string {
	if (criteria.length === 0) {
		return "";
	}

	const lines = ["### Acceptance Criteria", ""];
	for (let i = 0; i < criteria.length; i++) {
		const criterion = criteria[i] as AcceptanceCriterion;
		lines.push(`- [${criterion.checked ? "x" : " "}] ${criterion.text}`);
		lines.push(...(nestedLines[i] ?? []));
	}
	return trimBoundaryBlankLines(lines);
}

function joinBodyParts(parts: string[]): string {
	return parts
		.map((part) => trimBoundaryBlankLines(part.split("\n")))
		.filter((part) => part.length > 0)
		.join("\n\n");
}

/**
 * Render an acceptance-criteria checklist back into markdown.
 * Returns an empty string when there are no criteria.
 */
export function buildAcceptanceCriteria(criteria: AcceptanceCriterion[]): string {
	if (criteria.length === 0) {
		return "";
	}
	const lines = ["### Acceptance Criteria", ""];
	for (const c of criteria) {
		lines.push(`- [${c.checked ? "x" : " "}] ${c.text}`);
	}
	return lines.join("\n");
}

/**
 * If `line` is a checklist line, return it with its `[ ]`/`[x]` mark set to the
 * desired state (preserving the exact prefix and text); otherwise return null.
 * Used by the write-back reverse-sync to flip a box without rewriting the line.
 */
export function setCheckboxMark(line: string, checked: boolean): string | null {
	const match = line.match(CHECKBOX_LINE);
	if (!match) {
		return null;
	}
	return `${match[1]}[${checked ? "x" : " "}]${match[3]}`;
}

/** Whether a checklist line's mark is currently checked (`[x]`). Null if not a checkbox. */
export function checkboxState(line: string): boolean | null {
	const match = line.match(CHECKBOX_LINE);
	if (!match) {
		return null;
	}
	return match[2]?.toLowerCase() === "x";
}

/** The trimmed text of a checklist line, or null if not a checkbox. */
export function checkboxText(line: string): string | null {
	const match = line.match(CHECKBOX_LINE);
	if (!match) {
		return null;
	}
	return (match[3] ?? "").trim();
}

/**
 * Whether a line is an ATX heading (`#`..`######`). This is the same section
 * boundary `splitBody` uses to stop collecting criteria, exported so the
 * write-back reverse-sync stops at the exact same place.
 */
export function isHeadingLine(line: string): boolean {
	return ANY_HEADING.test(line.trim());
}

/** Join a narrative and a (possibly empty) acceptance-criteria block. */
export function joinBody(narrative: string, criteriaBlock: string): string {
	const parts = [narrative.trim(), criteriaBlock.trim()].filter((p) => p.length > 0);
	return parts.join("\n\n");
}
