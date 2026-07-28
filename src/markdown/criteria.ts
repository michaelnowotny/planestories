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
}

/**
 * The Acceptance-Criteria heading. Exported so effort detection (directives.ts)
 * scans exactly the same narrative region this splitter uses — otherwise the two
 * could disagree on where the narrative ends and effort could be hashed
 * inconsistently under `--sync-criteria`.
 */
export const AC_HEADING = /^#{1,6}\s+acceptance criteria\s*#*\s*$/i;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const ANY_HEADING = /^#{1,6}\s+/;
const AC_TEXT = /^acceptance criteria$/i;
const SETEXT_UNDERLINE = /^(?:=+|-+)$/;

/**
 * Index of the Acceptance-Criteria heading, or -1. Recognizes an ATX heading
 * (`### Acceptance Criteria`, closing `#`s tolerated) AND a Setext heading
 * (`Acceptance Criteria` on one line, `===`/`---` underline on the next). The
 * Setext form matters because Plane's HTML round-trip normalizes it to ATX; if
 * this splitter recognized only ATX, the narrative boundary (and any field
 * derived from it, like effort) would shift across the round-trip. Returns the
 * index of the heading (the TEXT line for a Setext heading).
 */
export function acHeadingIndex(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		const trimmed = (lines[i] as string).trim();
		if (AC_HEADING.test(trimmed)) {
			return i; // ATX
		}
		if (
			AC_TEXT.test(trimmed) &&
			i + 1 < lines.length &&
			SETEXT_UNDERLINE.test((lines[i + 1] as string).trim())
		) {
			return i; // Setext (text line; underline is at i+1)
		}
	}
	return -1;
}

/**
 * Split a story body into its narrative and its acceptance-criteria checklist.
 *
 * The acceptance-criteria section starts at an Acceptance-Criteria heading (ATX
 * or Setext; see `acHeadingIndex`) and runs until the next heading or end of file.
 * Only checkbox lines (`- [ ]` / `- [x]`) are collected as criteria.
 */
export function splitBody(body: string): SplitBody {
	const lines = body.split("\n");
	const headingIndex = acHeadingIndex(lines);

	if (headingIndex === -1) {
		return { narrative: body.trim(), criteria: [], hasHeading: false };
	}

	const narrative = lines.slice(0, headingIndex).join("\n").trim();

	const criteria: AcceptanceCriterion[] = [];
	for (let i = headingIndex + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (ANY_HEADING.test(line.trim())) {
			break; // next section
		}
		const match = line.match(CHECKBOX);
		if (match) {
			criteria.push({ checked: match[1]?.toLowerCase() === "x", text: (match[2] ?? "").trim() });
		}
	}

	return { narrative, criteria, hasHeading: true };
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

/** Join a narrative and a (possibly empty) acceptance-criteria block. */
export function joinBody(narrative: string, criteriaBlock: string): string {
	const parts = [narrative.trim(), criteriaBlock.trim()].filter((p) => p.length > 0);
	return parts.join("\n\n");
}
