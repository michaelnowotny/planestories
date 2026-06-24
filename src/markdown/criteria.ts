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

const AC_HEADING = /^#{1,6}\s+acceptance criteria\s*$/i;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * Split a story body into its narrative and its acceptance-criteria checklist.
 *
 * The acceptance-criteria section starts at an `### Acceptance Criteria` heading
 * and runs until the next heading or end of file. Only checkbox lines
 * (`- [ ]` / `- [x]`) are collected as criteria.
 */
export function splitBody(body: string): SplitBody {
	const lines = body.split("\n");
	const headingIndex = lines.findIndex((line) => AC_HEADING.test(line.trim()));

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
