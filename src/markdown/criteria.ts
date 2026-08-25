import { lexer, type Token, type Tokens } from "marked";
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

/** Canonical ATX authoring form, applied only after Marked confirms a real heading. */
export const AC_HEADING = /^#{1,6}[ \t]+acceptance criteria(?:[ \t]+#*)?[ \t]*\r?$/i;
/**
 * A checklist line, split into (prefix)(mark)(rest) so the mark can be rewritten
 * in place while preserving the exact bullet, indentation and text. The prefix
 * DELIBERATELY captures leading whitespace: a criterion list may legally be
 * indented, and dropping that indentation on write-back would reflow the file.
 *
 * This pattern deliberately does NOT decide peer-vs-nested: Marked's block tree
 * owns that structural verdict. It only preserves the exact authored marker,
 * state, text, and CRLF ending after a direct list item has been classified.
 */
export const CHECKBOX_LINE = /^([\t ]*[-*][ \t]+)\[([ xX])\]([ \t]+.*?)(\r?)$/;

export interface AcceptanceCriteriaLineClassification {
	/** Physical line containing the AC heading, or -1 when absent. */
	headingIndex: number;
	/** One line for ATX, two for Setext, zero when absent. */
	headingLength: 0 | 1 | 2;
	/** First line of the next top-level heading, or `lines.length`. */
	sectionEnd: number;
	/** Physical lines that are direct task items of a top-level list. */
	peerCheckboxLineIndices: number[];
}

interface PositionedToken {
	token: Token;
	startLine: number;
}

function newlineCount(value: string): number {
	return value.match(/\n/g)?.length ?? 0;
}

/**
 * Marked's block-token `raw` values partition the source. Keep that property
 * explicit: source positions drive write-back, so a future parser upgrade must
 * fail closed if it ever stops returning exact raw spans.
 */
function positionedBlockTokens(source: string): PositionedToken[] {
	const tokens = lexer(source);
	const positioned: PositionedToken[] = [];
	let start = 0;
	let startLine = 0;
	for (const token of tokens) {
		if (source.slice(start, start + token.raw.length) !== token.raw) {
			throw new ParseError(
				"Could not map parsed Acceptance Criteria tokens back to their source lines; left unchanged",
			);
		}
		positioned.push({ token, startLine });
		start += token.raw.length;
		startLine += newlineCount(token.raw);
	}
	if (start !== source.length) {
		throw new ParseError(
			"Could not map the complete Acceptance Criteria section back to its source lines; left unchanged",
		);
	}
	return positioned;
}

function firstRawLine(raw: string): string {
	const newline = raw.indexOf("\n");
	return newline === -1 ? raw : raw.slice(0, newline);
}

function commonMarkSource(lines: readonly string[]): string {
	// Marked normalizes CRLF in token.raw. Normalize only the parser copy so line
	// numbers remain identical while the caller's original bytes stay untouched.
	return lines.map((line) => line.replace(/\r$/, "")).join("\n");
}

function checkboxMatch(raw: string): RegExpMatchArray | null {
	return firstRawLine(raw).match(CHECKBOX_LINE);
}

/** Find a task item structurally below another list item. */
function nestedCheckboxText(tokens: readonly Token[]): string | null {
	for (const token of tokens) {
		// Do not descend through blockquotes/HTML/code. Their checkbox-looking text
		// is illustrative content, not a direct child list that Plane would flatten.
		if (token.type !== "list") continue;
		for (const item of token.items) {
			const match = item.task ? checkboxMatch(item.raw) : null;
			if (match) return (match[3] ?? "").trim();
			const deeper = nestedCheckboxText(item.tokens);
			if (deeper !== null) return deeper;
		}
	}
	return null;
}

function classifyTopLevelList(token: Tokens.List, tokenStartLine: number): number[] {
	const peers: number[] = [];
	let searchFrom = 0;
	for (const item of token.items) {
		const itemStart = token.raw.indexOf(item.raw, searchFrom);
		if (itemStart === -1) {
			throw new ParseError(
				"Could not map an Acceptance Criteria list item back to its source line; left unchanged",
			);
		}
		searchFrom = itemStart + item.raw.length;
		const match = item.task ? checkboxMatch(item.raw) : null;
		if (match) {
			peers.push(tokenStartLine + newlineCount(token.raw.slice(0, itemStart)));
		}
		const nested = nestedCheckboxText(item.tokens);
		if (nested !== null) {
			throw new ParseError(
				`Acceptance Criteria nested checkbox "${nested}" ` +
					"cannot round-trip without flattening; use an ordinary nested bullet, or outdent it to a top-level criterion",
			);
		}
	}
	return peers;
}

function isAcceptanceCriteriaHeading(token: Token): token is Tokens.Heading {
	return token.type === "heading" && token.text.trim().toLowerCase() === "acceptance criteria";
}

function isListToken(token: Token): token is Tokens.List {
	return token.type === "list" && "items" in token;
}

function headingLength(lines: readonly string[], headingIndex: number): 1 | 2 {
	return AC_HEADING.test(lines[headingIndex] ?? "") ? 1 : 2;
}

/**
 * Classify one complete Markdown body using Marked's CommonMark/GFM block tree.
 * This is the single structural verdict consumed by parsing and write-back.
 */
export function classifyAcceptanceCriteriaLines(
	lines: readonly string[],
): AcceptanceCriteriaLineClassification {
	const source = commonMarkSource(lines);
	const blocks = positionedBlockTokens(source);
	const headings = blocks.filter(({ token }) => isAcceptanceCriteriaHeading(token));
	if (headings.length === 0) {
		return {
			headingIndex: -1,
			headingLength: 0,
			sectionEnd: lines.length,
			peerCheckboxLineIndices: [],
		};
	}
	const heading = headings[0] as PositionedToken;
	if (headings.length > 1) {
		const duplicate = headings[1] as PositionedToken;
		throw new ParseError(
			`Duplicate Acceptance Criteria heading at line ${duplicate.startLine + 1}; a story may contain only one`,
		);
	}
	const headingBlockIndex = blocks.indexOf(heading);
	const nextHeading = blocks
		.slice(headingBlockIndex + 1)
		.find(({ token }) => token.type === "heading");
	const sectionEnd = nextHeading?.startLine ?? lines.length;
	const peers: number[] = [];
	for (const block of blocks.slice(headingBlockIndex + 1)) {
		if (block.startLine >= sectionEnd) break;
		if (isListToken(block.token)) {
			peers.push(...classifyTopLevelList(block.token, block.startLine));
		}
	}
	return {
		headingIndex: heading.startLine,
		headingLength: headingLength(lines, heading.startLine),
		sectionEnd,
		peerCheckboxLineIndices: peers,
	};
}

/**
 * The indices of lines that are PEER acceptance criteria, within an already
 * isolated criteria section.
 *
 * Compatibility/test projection of the same Marked-backed list classifier used
 * by `classifyAcceptanceCriteriaLines`. Production parsing and write-back both
 * consume that complete section classification, so neither re-derives heading
 * boundaries, fences, list containers, or `::acN` numbering.
 */
export function peerCheckboxLineIndices(lines: readonly string[]): number[] {
	const blocks = positionedBlockTokens(commonMarkSource(lines));
	return blocks.flatMap(({ token, startLine }) =>
		isListToken(token) ? classifyTopLevelList(token, startLine) : [],
	);
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
	return classifyAcceptanceCriteriaLines(lines).headingIndex;
}

/** Parse the one permitted AC section, retaining nested blocks for a lossless splice. */
function parseBody(body: string): ParsedBody {
	const lines = body.split("\n");
	const classification = classifyAcceptanceCriteriaLines(lines);
	const headingIndex = classification.headingIndex;

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

	const narrative = lines.slice(0, headingIndex).join("\n").trim();
	const criterionBlocks: CriterionBlock[] = [];
	const extras: string[] = [];
	let currentBlock: CriterionBlock | null = null;
	// THE shared classifier decides which checkboxes are criteria. This used to
	// re-derive it inline, and the two drifted: `groom --write-back` and this
	// parser disagreed on a two-level nested list, so a nested task became a
	// criterion here while write-back numbered around it.
	const acStart = headingIndex + classification.headingLength;
	const acEnd = classification.sectionEnd;
	const peerLines = new Set(classification.peerCheckboxLineIndices);
	for (let i = acStart; i < acEnd; i++) {
		const line = lines[i] as string;

		const checkbox = peerLines.has(i) ? line.match(CHECKBOX_LINE) : null;
		if (checkbox) {
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
		suffix: trimBoundaryBlankLines(lines.slice(acEnd)),
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
	return `${match[1]}[${checked ? "x" : " "}]${match[3]}${match[4] ?? ""}`;
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

/** Join a narrative and a (possibly empty) acceptance-criteria block. */
export function joinBody(narrative: string, criteriaBlock: string): string {
	const parts = [narrative.trim(), criteriaBlock.trim()].filter((p) => p.length > 0);
	return parts.join("\n\n");
}
