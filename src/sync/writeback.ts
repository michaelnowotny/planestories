import matter from "gray-matter";
import { ConfigError } from "../errors.ts";
import {
	checkboxState,
	checkboxText,
	classifyAcceptanceCriteriaLines,
	setCheckboxMark,
} from "../markdown/criteria.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import type { PlaneClient } from "../plane/client.ts";
import { type FetchedWorkItem, fetchProjectIndex, type ProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { criterionIndex, descriptionHasCriteria, isCriterionChild } from "./board-story.ts";
import { EXTERNAL_SOURCE } from "./importer.ts";

/** A single checkbox flipped by the reverse-sync. */
export interface CheckboxChange {
	/** The H2 story title the checkbox belongs to. */
	title: string;
	/** The story's Plane identifier (e.g. DATA-12), when known. */
	identifier: string | null;
	/** 0-based position within the story's acceptance-criteria checklist (the `::ac<n>` index). */
	position: number;
	/** The criterion's text (from the file line — never rebuilt from the board). */
	text: string;
	/** Checkbox state in the file before the change. */
	from: boolean;
	/** Desired state from the board (`stateGroup === "completed"`). */
	to: boolean;
}

/**
 * Apply desired checkbox states to a file's acceptance-criteria checklists IN
 * PLACE. `statesByPlaneId` maps a story's **`plane_id`** (read from its own yaml
 * block) to a sparse map of (0-based criterion position -> desired checked state).
 *
 * Keying by `plane_id` — NOT by title or ordinal — is the load-bearing choice: a
 * story is identified by the unique board id in its OWN yaml, so nothing depends on
 * how many `## ` headings or frontmatter blocks precede it. Two stories sharing an
 * H2 title never cross-contaminate, and an UNLINKED story (no `plane_id`) is simply
 * never matched. To locate each story's yaml block and body, it uses the SAME regex
 * (`` /```yaml\n([\s\S]*?)```/ ``) and gray-matter parse as `parseMarkdownFile`, so
 * write-back and the parser can never disagree about where a story's body — and thus
 * its `::ac<n>` numbering — begins.
 *
 * Only positions present in a story's map are touched; a gap (e.g. a criterion
 * removed on the board) leaves that box exactly as authored. Everything outside the
 * AC checklists — narrative, text, ordering, YAML — is preserved byte-for-byte. It
 * does NOT rebuild criterion text from the board (unlike `export --sync-criteria`),
 * so hand-authored wording survives.
 */
export function applyCheckboxStates(
	content: string,
	statesByPlaneId: Map<string, Map<number, boolean>>,
	identifiersByPlaneId?: Map<string, string | null>,
): { content: string; changes: CheckboxChange[]; warnings: string[] } {
	const lines = content.split("\n");
	const changes: CheckboxChange[] = [];
	const warnings: string[] = [];

	// Section boundaries: every `## ` line (naive, exactly like parseMarkdownFile's
	// `split(/^(?=## )/m)`). Over-segmentation (a `## ` in frontmatter or a code
	// fence) is harmless — only a section whose yaml carries a targeted `plane_id`
	// is ever touched.
	const boundaries: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] as string).startsWith("## ")) {
			boundaries.push(i);
		}
	}

	// Resolve each section's yaml up front so we can fail closed on an AMBIGUOUS
	// plane_id (the same id on more than one section — e.g. a copy-pasted story
	// whose metadata wasn't cleared). Applying one board state to two sections
	// would silently tick the wrong story, so a duplicated id is left untouched.
	const sections = boundaries.map((start, b) => {
		const end = b + 1 < boundaries.length ? (boundaries[b + 1] as number) : lines.length;
		return { start, end, ...sectionYaml(lines.slice(start, end)) };
	});
	const idCounts = new Map<string, number>();
	for (const s of sections) {
		if (s.planeId !== null) {
			const id = s.planeId.trim();
			idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		}
	}

	const warnedDuplicateId = new Set<string>();
	for (const section of sections) {
		if (section.planeId === null) {
			continue; // no board link in this section's yaml -> never a write-back target
		}
		const id = section.planeId.trim();
		const desired = statesByPlaneId.get(id);
		if (!desired) {
			continue;
		}
		if ((idCounts.get(id) ?? 0) > 1) {
			if (!warnedDuplicateId.has(id)) {
				const label = identifiersByPlaneId?.get(id) ?? id;
				warnings.push(
					`${label}: plane_id appears on more than one story in this file — ambiguous, left unchanged`,
				);
				warnedDuplicateId.add(id);
			}
			continue;
		}
		if (section.inlineTrailer) {
			// The parser's body begins immediately after the closing ``` (mid-line),
			// but this line-based rewriter can only start at the next line — so content
			// jammed onto the closing-fence line would desync `::ac<n>`. Fail closed.
			const label = identifiersByPlaneId?.get(id) ?? id;
			warnings.push(
				`${label}: text on the same line as the yaml block's closing \`\`\` — ambiguous body boundary, left unchanged`,
			);
			continue;
		}

		const { start, end, bodyLine } = section;
		const sectionLines = lines.slice(start, end);
		const classification = classifyAcceptanceCriteriaLines(sectionLines.slice(bodyLine));
		if (classification.headingIndex === -1) {
			continue;
		}
		const title = (lines[start] as string).replace(/^## /, "").trim();

		// Numbering must agree with `splitBody` EXACTLY — `::ac1` means the second
		// peer criterion, and counting every checkbox line would tick a nested one
		// instead. The complete section verdict (heading, next heading, peers) is
		// shared — write-back no longer reconstructs any of those boundaries.
		const peers = classification.peerCheckboxLineIndices.map((rel) => bodyLine + rel);

		for (const [pos, j] of peers.entries()) {
			const rel = sectionLines[j] as string;
			const current = checkboxState(rel);
			if (current === null) {
				throw new ConfigError(
					`${title}: parsed criterion line ${j + 1} could not be mapped back to its checkbox; left unchanged`,
				);
			}
			if (desired.has(pos)) {
				const want = desired.get(pos) as boolean;
				if (want !== current) {
					const abs = start + j;
					const rewritten = setCheckboxMark(lines[abs] as string, want);
					if (rewritten !== null) {
						lines[abs] = rewritten;
						changes.push({
							title,
							identifier: identifiersByPlaneId?.get(id) ?? null,
							position: pos,
							text: checkboxText(rel) ?? "",
							from: current,
							to: want,
						});
					}
				}
			}
		}
	}

	return { content: lines.join("\n"), changes, warnings };
}

/**
 * For one `## ` section (whose [0] is the heading line), resolve its `plane_id`
 * (from the first ```yaml``` block) and the section-line index at which the body
 * begins (just after that yaml block; 1 — right after the H2 — when there is no
 * yaml block). Uses the SAME yaml regex + gray-matter parse as `parseMarkdownFile`.
 *
 * `inlineTrailer` is true when there is non-whitespace content on the SAME physical
 * line as the closing ```` ``` ````. In that one case the parser's body starts
 * mid-line while this line-based rewriter cannot, so the caller fails closed.
 */
function sectionYaml(sectionLines: string[]): {
	planeId: string | null;
	bodyLine: number;
	inlineTrailer: boolean;
} {
	const restContent = sectionLines.slice(1).join("\n");
	const match = restContent.match(/```yaml\n([\s\S]*?)```/);
	if (!match || match.index === undefined) {
		return { planeId: null, bodyLine: 1, inlineTrailer: false };
	}
	let planeId: string | null = null;
	try {
		const data = matter(`---\n${match[1]}---\n`).data as Record<string, unknown>;
		const raw = data.plane_id;
		planeId = raw === undefined || raw === null || raw === "" ? null : String(raw);
	} catch {
		planeId = null; // malformed yaml -> treat as unlinked
	}
	// The body begins on the line AFTER the yaml block's closing fence. Count the
	// newlines consumed up to the end of the match: that many lines of `restContent`
	// precede the body, and `restContent` line k is `sectionLines[1 + k]`.
	const endChar = match.index + match[0].length;
	const newlineCount = (restContent.slice(0, endChar).match(/\n/g) ?? []).length;
	const nextNewline = restContent.indexOf("\n", endChar);
	const remainder =
		nextNewline === -1 ? restContent.slice(endChar) : restContent.slice(endChar, nextNewline);
	return { planeId, bodyLine: newlineCount + 2, inlineTrailer: remainder.trim().length > 0 };
}

export interface WriteBackOptions {
	config: ResolvedConfig;
	/** Files to reverse-sync. */
	files: string[];
	/** Project override for files whose frontmatter omits `project:`. */
	project?: string;
	/** Write changes to disk. Without this, it's a read-only diff (dry-run). */
	apply?: boolean;
}

export interface WriteBackFileResult {
	filePath: string;
	changes: CheckboxChange[];
	/** True when the file was rewritten on disk (apply + at least one change). */
	written: boolean;
	/** Stories in the file that carry a board link (`plane_id`). */
	linkedStories: number;
	/** Stories skipped because they have no `plane_id` yet. */
	unlinkedStories: number;
	/** Linked stories whose board item wasn't found (stale link / wrong project). */
	missingOnBoard: string[];
	/** Non-fatal warnings (e.g. ambiguous duplicate `::ac<n>` criteria left unchanged). */
	warnings: string[];
}

export interface WriteBackReport {
	files: WriteBackFileResult[];
	totalChanges: number;
	applied: boolean;
}

/**
 * Reverse-sync acceptance-criteria checkbox state board→file for the given files,
 * in place (decision #4 in the v2 plan). For each story with a board link, its
 * criterion sub-items' completion is written to the matching `- [x]`/`- [ ]` boxes,
 * matched by the `::ac<n>` positional index. Dry-run by default; `apply` writes.
 *
 * A project index is fetched once per distinct project referenced by the files
 * (from each story's `project`, falling back to `--project`/config).
 */
export async function reverseSyncCriteria(
	client: PlaneClient,
	options: WriteBackOptions,
): Promise<WriteBackReport> {
	const resolver = new Resolver(client);
	const indexCache = new Map<string, ProjectIndex>();

	const getIndex = async (projectName: string): Promise<ProjectIndex> => {
		const cached = indexCache.get(projectName);
		if (cached) {
			return cached;
		}
		const project = await resolver.resolveProject(projectName);
		const index = await fetchProjectIndex(client, project.id, project.identifier);
		indexCache.set(projectName, index);
		return index;
	};

	// Pass 1: read every file and compute its updated content, WITHOUT writing.
	// A throw here (e.g. a linked story with no resolvable project) aborts before
	// any file is touched, so a multi-file batch never leaves partial writes.
	interface Pending {
		filePath: string;
		original: string;
		updated: string;
		changes: CheckboxChange[];
		linkedStories: number;
		unlinkedStories: number;
		missingOnBoard: string[];
		warnings: string[];
	}
	const pending: Pending[] = [];

	for (const filePath of options.files) {
		const original = await Bun.file(filePath).text();
		const parsed = parseMarkdownFile(original, filePath);

		// Keyed by `plane_id` (the unique board id), NOT title or ordinal, so two
		// same-title stories can never cross-contaminate and an unlinked story (no
		// plane_id) is never a target. applyCheckboxStates re-reads each section's
		// plane_id from its own yaml, so these keys line up by construction.
		const statesByPlaneId = new Map<string, Map<number, boolean>>();
		const identifiersByPlaneId = new Map<string, string | null>();
		let linkedStories = 0;
		let unlinkedStories = 0;
		const missingOnBoard: string[] = [];
		const warnings: string[] = [];

		for (const story of parsed.stories) {
			if (story.kind === "criterion") {
				continue; // criterion sub-items aren't parents of criteria
			}
			if (!story.planeId?.trim()) {
				unlinkedStories++; // no board link yet (blank/absent plane_id)
				continue;
			}
			const planeId = story.planeId.trim();
			linkedStories++;
			identifiersByPlaneId.set(planeId, story.planeIdentifier ?? null);

			const projectName = story.project ?? options.project ?? options.config.defaultProject;
			if (!projectName) {
				throw new ConfigError(
					`Story "${story.title}" in ${filePath} has no project (set --project, a frontmatter project, or defaultProject).`,
				);
			}
			const index = await getIndex(projectName);
			const parent = index.byId.get(planeId);
			if (!parent) {
				missingOnBoard.push(story.planeIdentifier ?? story.title);
				continue;
			}

			// Legacy-gate (design §4.7, Codex #9): if the parent's criteria are
			// description-native (migrated to a task-list), its `::ac<n>` children are
			// administratively completed — reverse-syncing from them would wrongly tick
			// every file box. Board→file for description-native criteria is `export`.
			// Register an empty desired set (no changes) but keep file-level ambiguity
			// checks running for this story.
			if (descriptionHasCriteria(parent)) {
				statesByPlaneId.set(planeId, new Map());
				continue;
			}

			const children = (index.childrenByParent.get(planeId) ?? []).filter(
				(child: FetchedWorkItem) =>
					isCriterionChild(child) && child.externalSource === EXTERNAL_SOURCE,
			);

			// Fail closed on ambiguous `::ac<n>`: after a title rename the importer can
			// leave stale `<old-slug>::acN` children alongside fresh `<new-slug>::acN`
			// ones under the same parent (both planestories) — same position index. We
			// must NOT pick one arbitrarily, so any colliding position is left unchanged.
			const counts = new Map<number, number>();
			for (const child of children) {
				const idx = criterionIndex(child);
				counts.set(idx, (counts.get(idx) ?? 0) + 1);
			}
			const desired = new Map<number, boolean>();
			for (const child of children) {
				const idx = criterionIndex(child);
				if ((counts.get(idx) ?? 0) > 1) {
					continue; // ambiguous — skip this position
				}
				desired.set(idx, child.stateGroup === "completed");
			}
			const ambiguous = [...counts.entries()].filter(([, c]) => c > 1).map(([idx]) => idx);
			if (ambiguous.length > 0) {
				warnings.push(
					`${story.planeIdentifier ?? story.title}: duplicate criterion index(es) ${ambiguous
						.sort((a, b) => a - b)
						.map((i) => `::ac${i}`)
						.join(", ")} on the board (stale renamed criteria?) — those boxes were left unchanged`,
				);
			}
			// Register EVERY linked, on-board story (even one with no criterion children,
			// so `desired` is empty) so applyCheckboxStates still surfaces file-level
			// ambiguities — a duplicate plane_id or an inline closing-fence — for it. An
			// empty `desired` makes no changes but does not suppress those warnings.
			statesByPlaneId.set(planeId, desired);
		}

		const {
			content: updated,
			changes,
			warnings: coreWarnings,
		} = applyCheckboxStates(original, statesByPlaneId, identifiersByPlaneId);
		pending.push({
			filePath,
			original,
			updated,
			changes,
			linkedStories,
			unlinkedStories,
			missingOnBoard,
			warnings: [...warnings, ...coreWarnings],
		});
	}

	// Pass 2: write the files that changed (only when applying).
	const results: WriteBackFileResult[] = [];
	for (const p of pending) {
		let written = false;
		if (options.apply && p.changes.length > 0 && p.updated !== p.original) {
			await Bun.write(p.filePath, p.updated);
			written = true;
		}
		results.push({
			filePath: p.filePath,
			changes: p.changes,
			written,
			linkedStories: p.linkedStories,
			unlinkedStories: p.unlinkedStories,
			missingOnBoard: p.missingOnBoard,
			warnings: p.warnings,
		});
	}

	return {
		files: results,
		totalChanges: results.reduce((sum, r) => sum + r.changes.length, 0),
		applied: Boolean(options.apply),
	};
}
