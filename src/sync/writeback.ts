import { ConfigError } from "../errors.ts";
import {
	acHeadingIndex,
	checkboxState,
	checkboxText,
	isHeadingLine,
	setCheckboxMark,
} from "../markdown/criteria.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import type { PlaneClient } from "../plane/client.ts";
import { type FetchedWorkItem, fetchProjectIndex, type ProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { criterionIndex, isCriterionChild } from "./board-story.ts";
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
 * PLACE. `statesByTitle` maps an H2 story title to a sparse map of
 * (0-based criterion position -> desired checked state). Only positions present
 * in the map are touched; a gap (e.g. a criterion removed on the board) leaves
 * that box exactly as authored. Everything outside the AC checklists — narrative,
 * text, ordering, YAML — is preserved byte-for-byte.
 *
 * This is the pure, offline heart of the reverse-sync: it does NOT rebuild the
 * criterion text from the board (unlike `export --sync-criteria`), so hand-authored
 * wording survives. It reuses `acHeadingIndex`/`isHeadingLine`/`checkboxState` so a
 * checkbox's position matches exactly the `::ac<n>` numbering the importer assigned.
 */
export function applyCheckboxStates(
	content: string,
	statesByTitle: Map<string, Map<number, boolean>>,
	identifiersByTitle?: Map<string, string | null>,
): { content: string; changes: CheckboxChange[] } {
	const lines = content.split("\n");
	const changes: CheckboxChange[] = [];

	// Story ranges by H2 boundary.
	const boundaries: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] as string).startsWith("## ")) {
			boundaries.push(i);
		}
	}

	for (let b = 0; b < boundaries.length; b++) {
		const start = boundaries[b] as number;
		const end = b + 1 < boundaries.length ? (boundaries[b + 1] as number) : lines.length;
		const title = (lines[start] as string).replace(/^## /, "").trim();
		const desired = statesByTitle.get(title);
		if (!desired) {
			continue;
		}

		const storyLines = lines.slice(start, end);
		// Start the AC search AFTER the story's ```yaml``` block, exactly like the
		// parser extracts the body — otherwise an AC heading placed before the yaml
		// fence would be counted here but not by the importer, misaligning ::ac<n>.
		const contentStart = contentStartOffset(storyLines);
		const acRel = acHeadingIndex(storyLines.slice(contentStart));
		if (acRel === -1) {
			continue;
		}
		const acIdx = contentStart + acRel;

		let pos = 0;
		for (let j = acIdx + 1; j < storyLines.length; j++) {
			const rel = storyLines[j] as string;
			if (isHeadingLine(rel)) {
				break; // next section — criteria numbering ends here (matches splitBody)
			}
			const current = checkboxState(rel);
			if (current === null) {
				continue; // non-checkbox line inside the AC block
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
							identifier: identifiersByTitle?.get(title) ?? null,
							position: pos,
							text: checkboxText(rel) ?? "",
							from: current,
							to: want,
						});
					}
				}
			}
			pos++;
		}
	}

	return { content: lines.join("\n"), changes };
}

/**
 * Offset within a story's lines (whose [0] is the `## ` heading) at which the
 * body content begins — i.e. after the first ```yaml ... ``` block, mirroring how
 * the parser slices the body. Returns 1 (just after the H2) when there is no yaml
 * block, and the whole length when a yaml fence is opened but never closed.
 */
function contentStartOffset(storyLines: string[]): number {
	for (let k = 1; k < storyLines.length; k++) {
		if ((storyLines[k] as string).trim() === "```yaml") {
			for (let m = k + 1; m < storyLines.length; m++) {
				if ((storyLines[m] as string).trim() === "```") {
					return m + 1;
				}
			}
			return storyLines.length; // unclosed fence — no usable body
		}
	}
	return 1;
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
	}
	const pending: Pending[] = [];

	for (const filePath of options.files) {
		const original = await Bun.file(filePath).text();
		const parsed = parseMarkdownFile(original, filePath);

		const statesByTitle = new Map<string, Map<number, boolean>>();
		const identifiersByTitle = new Map<string, string | null>();
		let linkedStories = 0;
		let unlinkedStories = 0;
		const missingOnBoard: string[] = [];

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
			identifiersByTitle.set(story.title, story.planeIdentifier ?? null);

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

			const children = (index.childrenByParent.get(planeId) ?? []).filter(
				(child: FetchedWorkItem) =>
					isCriterionChild(child) && child.externalSource === EXTERNAL_SOURCE,
			);
			if (children.length === 0) {
				continue;
			}

			const desired = new Map<number, boolean>();
			for (const child of children) {
				desired.set(criterionIndex(child), child.stateGroup === "completed");
			}
			statesByTitle.set(story.title, desired);
		}

		const { content: updated, changes } = applyCheckboxStates(
			original,
			statesByTitle,
			identifiersByTitle,
		);
		pending.push({
			filePath,
			original,
			updated,
			changes,
			linkedStories,
			unlinkedStories,
			missingOnBoard,
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
		});
	}

	return {
		files: results,
		totalChanges: results.reduce((sum, r) => sum + r.changes.length, 0),
		applied: Boolean(options.apply),
	};
}
