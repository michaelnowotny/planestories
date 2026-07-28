import matter from "gray-matter";
import { ParseError } from "../errors.ts";
import type { FileFrontmatter, ParsedFile, PlanePriority, StoryKind, UserStory } from "../types.ts";
import {
	extractDependencyDirectives,
	hasAnyEffortMention,
	injectEffortLine,
	normalizeRelationIdentifiers,
	parseEffortDays,
	parseRelationIdentifiers,
	parseYamlEffort,
} from "./directives.ts";
import { htmlToMarkdown, markdownToHtml } from "./html.ts";

const VALID_KINDS: ReadonlySet<string> = new Set(["story", "criterion", "epic"]);

/** Normalize a `kind` yaml value to a known StoryKind, or null when absent/unknown. */
function normalizeKind(value: unknown): StoryKind | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	const str = String(value).trim().toLowerCase();
	return VALID_KINDS.has(str) ? (str as StoryKind) : null;
}

/**
 * Parse a markdown file containing user stories into a structured ParsedFile.
 *
 * Format rules:
 * - File-level YAML frontmatter (---...---) contains the project default
 * - H2 headings (## ) separate individual stories
 * - After each H2, an optional fenced YAML block (```yaml ... ```) contains per-story metadata
 * - Everything between the YAML block (or H2 if no YAML) and the next H2/EOF is the story body
 */
export function parseMarkdownFile(content: string, filePath: string): ParsedFile {
	// 1. Extract file-level frontmatter using gray-matter
	const { data: rawFrontmatter, content: bodyContent } = matter(content);

	const frontmatter: FileFrontmatter = {};
	if (rawFrontmatter.project) {
		frontmatter.project = String(rawFrontmatter.project);
	}

	// 2. Split at H2 boundaries
	// We split on lines that start with "## " and keep the delimiter
	const h2Regex = /^## /m;
	if (!h2Regex.test(bodyContent)) {
		throw new ParseError(
			`No H2 headings found in file: ${filePath}. Each user story must start with an H2 heading (## ).`,
		);
	}

	// Split the content into sections. The first element before the first H2 is preamble (ignored).
	const sections = bodyContent.split(/^(?=## )/m);

	const stories: UserStory[] = [];

	for (const section of sections) {
		const trimmed = section.trim();
		if (!trimmed.startsWith("## ")) {
			// Skip preamble content before first H2
			continue;
		}

		const story = parseStorySection(trimmed, frontmatter);
		stories.push(story);
	}

	return {
		frontmatter,
		stories,
		filePath,
	};
}

/**
 * Find H2 headings that look like design-doc sections rather than user stories:
 * no fenced `yaml` block AND no acceptance-criteria checklist. `import --strict`
 * refuses these; the default warns. Guards against importing an ADR/design doc as
 * work items (the 308->309 lesson).
 */
export function findNonStoryHeadings(content: string): string[] {
	const { content: body } = matter(content);
	const sections = body.split(/^(?=## )/m).filter((s) => s.trim().startsWith("## "));
	const suspicious: string[] = [];
	for (const section of sections) {
		const title = (section.split("\n")[0] ?? "").replace(/^## /, "").trim();
		const hasYaml = /```yaml/.test(section);
		const hasCriteria =
			/^#{2,}\s*acceptance criteria/im.test(section) || /-\s*\[[ xX]\]/.test(section);
		if (!hasYaml && !hasCriteria) {
			suspicious.push(title);
		}
	}
	return suspicious;
}

/**
 * Parse a single story section (starting with ## ) into a UserStory.
 */
function parseStorySection(section: string, frontmatter: FileFrontmatter): UserStory {
	const lines = section.split("\n");

	// Extract title from the first line (## Title)
	const titleLine = lines[0] as string;
	const title = titleLine.replace(/^## /, "").trim();

	// Look for fenced YAML block: ```yaml ... ```
	const restContent = lines.slice(1).join("\n");
	const yamlBlockRegex = /```yaml\n([\s\S]*?)```/;
	const yamlMatch = restContent.match(yamlBlockRegex);

	let metadata: Record<string, unknown> = {};
	let body: string;

	if (yamlMatch) {
		// Parse the YAML content using gray-matter's trick
		const yamlContent = yamlMatch[1] as string;
		const parsed = matter(`---\n${yamlContent}---\n`);
		metadata = parsed.data;

		// Body is everything after the closing ``` of the YAML block
		const yamlBlockEnd = restContent.indexOf(yamlMatch[0]) + yamlMatch[0].length;
		body = restContent.slice(yamlBlockEnd).trim();
	} else {
		// No YAML block - everything after the title is the body
		body = restContent.trim();
	}

	// Extract metadata fields with proper null handling
	const planeId = extractStringOrNull(metadata.plane_id);
	const planeIdentifier = extractStringOrNull(metadata.plane_identifier);
	const planeUrl = extractStringOrNull(metadata.plane_url);
	const planeHash = extractStringOrNull(metadata.plane_hash);
	const priority = normalizePriority(metadata.priority);
	const labels = extractLabels(metadata.labels);
	const estimate = extractNumberOrNull(metadata.estimate);
	const assignee = extractStringOrNull(metadata.assignee);
	const status = extractStringOrNull(metadata.status);

	// Per-story `project:` overrides the file frontmatter; falls back to it.
	const project = extractStringOrNull(metadata.project) ?? frontmatter.project ?? null;
	const parent = extractStringOrNull(metadata.parent);
	const dependencyDirectives = extractDependencyDirectives(body);
	body = dependencyDirectives.body;
	let blockedBy = normalizeRelationIdentifiers([
		...parseRelationIdentifiers(metadata.blocked_by),
		...dependencyDirectives.blockedBy,
	]);
	let blocks = normalizeRelationIdentifiers([
		...parseRelationIdentifiers(metadata.blocks),
		...dependencyDirectives.blocks,
	]);
	let relatesTo = parseRelationIdentifiers(metadata.relates_to);
	const ownIdentifier = planeIdentifier?.trim().toUpperCase();
	const relationValidationErrors: string[] = [];
	if (ownIdentifier) {
		for (const [field, values] of [
			["blocked_by", blockedBy],
			["blocks", blocks],
			["relates_to", relatesTo],
		] as const) {
			if (values.includes(ownIdentifier)) {
				relationValidationErrors.push(`${ownIdentifier} cannot reference itself in ${field}`);
			}
		}
		blockedBy = blockedBy.filter((identifier) => identifier !== ownIdentifier);
		blocks = blocks.filter((identifier) => identifier !== ownIdentifier);
		relatesTo = relatesTo.filter((identifier) => identifier !== ownIdentifier);
	}
	const kind = normalizeKind(metadata.kind);
	const comment = extractStringOrNull(metadata.comment);

	// Developer-day effort. The `**Effort:** N dev-days` narrative line is the source
	// of truth (it round-trips through the description). A YAML `effort_days:` is input
	// sugar: when the body has NO effort mention at all, materialize one so it is
	// stored + hashed the same way. Guards that keep round-trip idempotent:
	//  - a recognized narrative line wins (skip the YAML path);
	//  - if the body mentions effort anywhere (e.g. an unrecognized after-AC line) we
	//    do NOT inject, so we never create a duplicate/orphan;
	//  - `parseYamlEffort` rejects anything that can't be faithfully rendered; and
	//  - we accept the injection only if it actually re-parses to the same value, so a
	//    pathological body (unclosed fence, etc.) can never leave an orphan line.
	let effortDays = parseEffortDays(body);
	if (effortDays === null && !hasAnyEffortMention(body)) {
		const yamlEffort = parseYamlEffort(metadata.effort_days);
		if (yamlEffort !== null) {
			const injected = injectEffortLine(body, yamlEffort);
			// Accept the injection only if the value survives in BOTH the raw injected
			// body AND its canonical (board-stored) form. The canonical check rejects a
			// line that would be orphaned once the HTML round-trip normalizes the AC
			// heading (e.g. Setext -> ATX), so we decline to inject (-> null, lint flags
			// "missing effort") rather than materialize an orphan after the criteria.
			const canonicalInjected = htmlToMarkdown(markdownToHtml(injected));
			if (
				parseEffortDays(injected) === yamlEffort &&
				parseEffortDays(canonicalInjected) === yamlEffort
			) {
				body = injected;
				effortDays = yamlEffort;
			}
		}
	}

	return {
		title,
		planeId,
		planeIdentifier,
		planeUrl,
		planeHash,
		priority,
		labels,
		estimate,
		effortDays,
		assignee,
		status,
		body,
		project,
		parent,
		blockedBy,
		blocks,
		relatesTo,
		...(relationValidationErrors.length > 0 ? { relationValidationErrors } : {}),
		kind,
		comment,
	};
}

const VALID_PRIORITIES: ReadonlySet<string> = new Set(["urgent", "high", "medium", "low", "none"]);

/** Legacy Linear integer priorities → Plane strings (0/None map to unset). */
const LEGACY_PRIORITY: Record<number, PlanePriority | null> = {
	0: null,
	1: "urgent",
	2: "high",
	3: "medium",
	4: "low",
};

/**
 * Normalize a priority value to a Plane priority string.
 * Accepts Plane strings (urgent|high|medium|low|none) case-insensitively, and
 * legacy Linear integers 0-4 for backward compatibility. "none" and 0 map to
 * null (unset); Plane defaults a work item to "none" anyway.
 */
export function normalizePriority(value: unknown): PlanePriority | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}

	if (typeof value === "number" || /^\d+$/.test(String(value))) {
		const num = Number(value);
		return LEGACY_PRIORITY[num] ?? null;
	}

	const str = String(value).trim().toLowerCase();
	if (str === "none") {
		return null;
	}
	if (VALID_PRIORITIES.has(str)) {
		return str as PlanePriority;
	}
	return null;
}

function extractStringOrNull(value: unknown): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	return String(value);
}

function extractNumberOrNull(value: unknown): number | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	const num = Number(value);
	if (Number.isNaN(num)) {
		return null;
	}
	return num;
}

function extractLabels(value: unknown): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map(String);
	}
	if (typeof value === "string" && value.trim() !== "") {
		// Handle comma-separated string
		return value.split(",").map((s) => s.trim());
	}
	return [];
}
