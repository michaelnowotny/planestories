import { createHash } from "node:crypto";
import { type AcceptanceCriterion, splitBody } from "../markdown/criteria.ts";
import { findNonStoryHeadings, parseMarkdownFile } from "../markdown/parser.ts";
import { type WriteBackUpdate, writeBackIds } from "../markdown/writer.ts";
import type { PlaneClient } from "../plane/client.ts";
import {
	type CreateWorkItemInput,
	createWorkItem,
	ensureComment,
	type FetchedWorkItem,
	fetchProjectIndex,
	findWorkItemByExternalId,
	normalizeTitle,
	type ProjectIndex,
	type UpdateWorkItemInput,
	updateWorkItem,
	type WorkItemRef,
} from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ImportResult, ImportSummary, ResolvedConfig, UserStory } from "../types.ts";
import { boardItemToStory } from "./board-story.ts";
import { hashStoryPayload } from "./story-hash.ts";

/** Lazily fetch (and memoize) a project's work-item index — one list per project per run. */
type IndexProvider = (projectId: string, projectIdentifier: string) => Promise<ProjectIndex>;

/** Identifies work items this tool created, used for idempotent re-imports. */
export const EXTERNAL_SOURCE = "planestories";

export interface ImportOptions {
	files: string[];
	config: ResolvedConfig;
	project?: string;
	dryRun?: boolean;
	noWriteBack?: boolean;
	/** Create labels that don't exist in the project instead of skipping them. */
	createLabels?: boolean;
	/** In dry-run, do read-only resolution (project/state/assignee/labels) to validate. */
	check?: boolean;
	/** Sync each acceptance criterion to a Plane sub-item (state from its checkbox). */
	syncCriteria?: boolean;
	/** Tag every created item with this label (auto-created); overrides config.sourceLabel. */
	sourceLabel?: string;
	/** Re-import even when the content hash matches (bypass skip-unchanged). */
	force?: boolean;
	/**
	 * Only update the state of already-linked items (by plane_id) from their yaml
	 * `status`; ignore all other fields. Unlinked stories are skipped with a
	 * warning. Does not write back plane_hash. Useful for bulk status transitions.
	 */
	statusOnly?: boolean;
	/**
	 * When a new story's title exactly matches an existing item, adopt that item
	 * (update it + write its plane_id back) instead of skipping. A single exact
	 * match only — multiple matches are a hard error.
	 */
	adoptDuplicates?: boolean;
	/** Create even when a same-title item already exists (bypass the duplicate guard). */
	forceCreate?: boolean;
	/** Refuse headings that look like design-doc sections (no yaml + no criteria). */
	strict?: boolean;
}

/**
 * Import user stories from markdown files into Plane.
 *
 * Algorithm:
 * 1. Read each file and parse with parseMarkdownFile
 * 2. For each story, resolve names to UUIDs (project, labels, assignee, state)
 * 3. If plane_id present -> update; else look up by external_id; else create
 * 4. If not dry-run: make API calls
 * 5. If not no-write-back: write back plane_id / plane_identifier / plane_url
 * 6. Continue on failure per story
 * 7. Return ImportSummary
 */
export async function importStories(
	client: PlaneClient,
	options: ImportOptions,
): Promise<ImportSummary> {
	const resolver = new Resolver(client);
	const results: ImportResult[] = [];
	const structureWarnings: string[] = [];

	// One work-item index per project, fetched lazily (only creates, adopts, and
	// hashless-linked stories need it) and reused across every story in the run.
	const indexCache = new Map<string, Promise<ProjectIndex>>();
	const getIndex: IndexProvider = (projectId, projectIdentifier) => {
		let pending = indexCache.get(projectId);
		if (!pending) {
			pending = fetchProjectIndex(client, projectId, projectIdentifier);
			indexCache.set(projectId, pending);
		}
		return pending;
	};

	for (const filePath of options.files) {
		const fileContent = await Bun.file(filePath).text();
		const parsed = parseMarkdownFile(fileContent, filePath);

		const writeBackUpdates: WriteBackUpdate[] = [];
		const suspicious = new Set(findNonStoryHeadings(fileContent));

		for (const story of parsed.stories) {
			// Structural guard: a heading with no yaml block and no acceptance criteria
			// is probably a design-doc section, not a story. --strict refuses it.
			if (suspicious.has(story.title)) {
				if (options.strict) {
					results.push({
						story,
						action: "failed",
						error:
							"looks like a design-doc heading (no YAML block, no acceptance criteria) — refused by --strict",
					});
					continue;
				}
				structureWarnings.push(
					`"${story.title}" has no YAML block and no acceptance criteria — imported anyway (use --strict to refuse)`,
				);
			}

			const result = await processStory(client, resolver, story, options, getIndex);
			results.push(result);

			// Write back identifiers + content hash for created/updated stories, and
			// for an ADOPTED hashless-but-linked story (action "unchanged" but the file
			// had no plane_hash yet — store it so it is warm next time). In-place hash
			// refreshes are idempotent on plane_id/identifier/url. Fast-path unchanged
			// (file already had a matching hash) and failed/skipped write nothing.
			const linkable =
				result.action === "created" ||
				result.action === "updated" ||
				(result.action === "unchanged" && story.planeHash === null);
			if (linkable && result.planeId && result.planeIdentifier && result.planeUrl) {
				writeBackUpdates.push({
					title: story.title,
					planeId: result.planeId,
					planeIdentifier: result.planeIdentifier,
					planeUrl: result.planeUrl,
					// Undefined on a partial follow-up -> plane_hash is not written, so a
					// re-run recomputes and completes the interrupted work.
					planeHash: result.planeHash,
				});
			}
		}

		if (!options.dryRun && !options.noWriteBack && writeBackUpdates.length > 0) {
			const updatedContent = writeBackIds(filePath, fileContent, writeBackUpdates);
			await Bun.write(filePath, updatedContent);
		}
	}

	const summary = buildSummary(results);
	summary.labelsCreated = [...resolver.createdLabelNames];
	summary.labelsSkipped = [...resolver.skippedLabelNames];
	summary.structureWarnings = structureWarnings;
	return summary;
}

/**
 * Process a single story: resolve names, then create or update.
 */
async function processStory(
	client: PlaneClient,
	resolver: Resolver,
	story: UserStory,
	options: ImportOptions,
	getIndex: IndexProvider,
): Promise<ImportResult> {
	// Content hash of the intended payload (no network). A linked story whose hash
	// matches its stored plane_hash would be a no-op, so it is skipped with zero API
	// writes. Computed here so dry-run and real imports agree on "unchanged".
	const { narrative, criteria } = splitBody(story.body);
	const bodyForParent = options.syncCriteria ? narrative : story.body;
	const contentHash = hashStoryPayload(story, {
		syncCriteria: Boolean(options.syncCriteria),
		labels: effectiveLabelNames(story, options),
	});

	if (story.planeId && story.planeHash && !options.force && contentHash === story.planeHash) {
		return {
			story,
			action: "unchanged",
			planeId: story.planeId,
			planeIdentifier: story.planeIdentifier ?? undefined,
			planeUrl: story.planeUrl ?? undefined,
			planeHash: contentHash,
		};
	}

	try {
		// Precedence: --project (force all) > per-story/frontmatter > defaultProject.
		const projectName = options.project ?? story.project ?? options.config.defaultProject;
		if (!projectName) {
			return {
				story,
				action: "failed",
				error: "No project specified for story and no default project configured",
			};
		}

		const project = await resolver.resolveProject(projectName);

		// --status-only: PATCH just the state of already-linked items. No description
		// re-render, no label/assignee touch, no create. Deliberately does NOT write
		// back plane_hash (only the state was synced, not the full payload — claiming
		// a full sync would let a later import skip a genuinely-changed body).
		if (options.statusOnly) {
			const stateId = story.status
				? await resolver.resolveStateId(project.id, story.status)
				: undefined;

			if (options.dryRun) {
				const notes: string[] = [];
				if (!story.planeId) notes.push("no plane_id — would be skipped");
				if (story.status && !stateId) notes.push(`status "${story.status}" not found`);
				return {
					story,
					action: "skipped",
					wouldAction: "update",
					note: notes.join("; ") || undefined,
				};
			}

			if (!story.planeId) {
				return {
					story,
					action: "skipped",
					note: "status-only: no plane_id — skipped (import fully first to link it)",
				};
			}
			if (!stateId) {
				return {
					story,
					action: "skipped",
					note: story.status
						? `status "${story.status}" not found in project`
						: "status-only: no status set — nothing to update",
				};
			}

			const ref = await updateWorkItem(client, project.id, story.planeId, { stateId });
			await postEvidenceComment(client, project.id, story.planeId, story.comment);
			return {
				story,
				action: "updated",
				planeId: ref.id,
				planeIdentifier: `${project.identifier}-${ref.sequenceId}`,
				planeUrl: client.workItemWebUrl(project.id, ref.id),
				projectUrl: client.projectBoardUrl(project.id),
			};
		}

		// Hashless-but-linked (P0-1 warm start for legacy files): the file carries a
		// plane_id but no plane_hash, so the fast-path skip can't fire. Rather than
		// blind-rewrite, reconstruct the board item from the project index (ONE list,
		// not a per-item GET) and compare hashes; if equal, skip + adopt the hash.
		if (story.planeId && !story.planeHash && !options.force) {
			const index = await getIndex(project.id, project.identifier);
			const boardItem = index.byId.get(story.planeId);
			if (boardItem) {
				const children = options.syncCriteria
					? index.childrenByParent.get(boardItem.id)
					: undefined;
				const boardStory = boardItemToStory(
					client,
					boardItem,
					project.id,
					project.identifier,
					projectName,
					Boolean(options.syncCriteria),
					children,
				);
				if (boardStory.planeHash === contentHash) {
					return {
						story,
						action: "unchanged",
						planeId: boardItem.id,
						planeIdentifier: `${project.identifier}-${boardItem.sequenceId}`,
						planeUrl: client.workItemWebUrl(project.id, boardItem.id),
						planeHash: contentHash,
					};
				}
			}
			// Not found or differs -> fall through to the normal update (writes the hash).
		}

		// Decide the write target using the project index — the SAME decision the
		// dry-run preview reports, so preview and apply can never diverge. A no-plane_id
		// story that matches an existing item (by our external_id OR by exact title) is a
		// duplicate, NOT a silent update — closing the cross-file hijack hole.
		const target = await resolveTarget(story, project, options, getIndex);

		// Dry-run: report exactly what apply would do (+ --check validation notes), no writes.
		if (options.dryRun) {
			let note: string | undefined;
			if (options.check) {
				const notes: string[] = [];
				if (story.assignee && !(await resolver.resolveAssigneeId(project.id, story.assignee))) {
					notes.push(`assignee "${story.assignee}" not found`);
				}
				if (story.status && !(await resolver.resolveStateId(project.id, story.status))) {
					notes.push(`status "${story.status}" not found`);
				}
				if (story.parent) {
					const idx = await getIndex(project.id, project.identifier);
					if (!idx.byIdentifier.has(story.parent)) {
						notes.push(`parent "${story.parent}" not found`);
					}
				}
				note = notes.join("; ") || undefined;
			}
			return previewFromTarget(story, target, project.identifier, note);
		}

		// Apply — non-write outcomes first.
		if (target.kind === "duplicate-multi") {
			const ids = target.items.map((m) => `${project.identifier}-${m.sequenceId}`).join(", ");
			return {
				story,
				action: "failed",
				error: `--adopt-duplicates: ${target.items.length} items share the title "${story.title}" in ${project.identifier} (${ids}). Refusing to auto-pick — set plane_id manually on the story.`,
			};
		}
		if (target.kind === "skip-duplicate") {
			const m = target.item;
			return {
				story,
				action: "skipped",
				note: `duplicate of ${project.identifier}-${m.sequenceId} (${
					m.stateName ?? "no state"
				}) — skipped. Set plane_id to link it, or pass --adopt-duplicates / --force-create.`,
			};
		}

		// Merge labels: story.labels + config.defaultLabels (deduplicated).
		const allLabels = deduplicateLabels(story.labels, options.config.defaultLabels);
		const labelIds: string[] =
			allLabels.length > 0
				? await resolver.resolveLabelIds(project.id, allLabels, options.createLabels)
				: [];

		const assigneeId = story.assignee
			? await resolver.resolveAssigneeId(project.id, story.assignee)
			: undefined;

		const stateId = story.status
			? await resolver.resolveStateId(project.id, story.status)
			: undefined;

		// Opt-in source label: tag every created item, auto-creating the label
		// regardless of --create-labels. Off unless configured / flagged.
		const sourceLabel = options.sourceLabel ?? options.config.sourceLabel;
		if (sourceLabel) {
			const [sourceLabelId] = await resolver.resolveLabelIds(project.id, [sourceLabel], true);
			if (sourceLabelId && !labelIds.includes(sourceLabelId)) {
				labelIds.push(sourceLabelId);
			}
		}

		// narrative / criteria / bodyForParent were computed above (for the hash).
		// When syncing criteria to sub-items the parent holds the narrative only.
		const input: CreateWorkItemInput = { name: story.title };
		if (bodyForParent) input.body = bodyForParent;
		if (labelIds.length > 0) input.labelIds = labelIds;
		if (assigneeId) input.assigneeId = assigneeId;
		if (story.priority !== null) input.priority = story.priority;
		if (story.estimate !== null) input.estimate = story.estimate;
		if (stateId) input.stateId = stateId;

		// Cross-file nesting: `parent: DATA-N` -> the parent's UUID via the index.
		if (story.parent) {
			const index = await getIndex(project.id, project.identifier);
			const parentItem = index.byIdentifier.get(story.parent);
			if (!parentItem) {
				return {
					story,
					action: "failed",
					error: `parent "${story.parent}" not found in project ${project.identifier}`,
				};
			}
			input.parent = parentItem.id;
		}

		const externalId = makeExternalId(story.title);

		let ref: WorkItemRef;
		let action: "created" | "updated";
		if (target.kind === "update") {
			ref = await updateWorkItem(client, project.id, target.id, input);
			action = "updated";
		} else {
			// create
			input.externalId = externalId;
			input.externalSource = EXTERNAL_SOURCE;
			ref = await createWorkItem(client, project.id, input);
			action = "created";
		}

		// The parent is created/updated at this point. A failure in the FOLLOW-UP
		// work (criteria sub-items, evidence comment) must NOT discard it — otherwise
		// the plane_id is orphaned and every re-run re-creates + fails again. Roll such
		// failures up into a warning on an otherwise-successful result, so the plane_id
		// is written back and a re-run retries only the follow-up.
		let followUpNote: string | undefined;

		if (options.syncCriteria && criteria.length > 0) {
			try {
				await syncCriteriaChildren(client, resolver, project.id, ref.id, externalId, criteria);
			} catch (error) {
				followUpNote = `parent ${action}, but criteria sync did not finish (${
					error instanceof Error ? error.message : String(error)
				}) — re-run to complete it`;
			}
		}

		try {
			await postEvidenceComment(client, project.id, ref.id, story.comment);
		} catch (error) {
			const commentNote = `evidence comment failed (${
				error instanceof Error ? error.message : String(error)
			})`;
			followUpNote = followUpNote ? `${followUpNote}; ${commentNote}` : commentNote;
		}

		const result = makeResult(
			client,
			story,
			project.id,
			project.identifier,
			ref,
			action,
			contentHash,
		);
		if (followUpNote) {
			result.note = followUpNote;
			// Withhold the content hash: the item is linked, but a re-run must not be
			// skipped-as-unchanged so it can finish the interrupted follow-up work.
			result.planeHash = undefined;
		}
		return result;
	} catch (error) {
		return {
			story,
			action: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function makeResult(
	client: PlaneClient,
	story: UserStory,
	projectId: string,
	projectIdentifier: string,
	ref: { id: string; sequenceId: number },
	action: "created" | "updated",
	contentHash: string,
): ImportResult {
	return {
		story,
		action,
		planeId: ref.id,
		planeIdentifier: `${projectIdentifier}-${ref.sequenceId}`,
		planeUrl: client.workItemWebUrl(projectId, ref.id),
		planeHash: contentHash,
		projectUrl: client.projectBoardUrl(projectId),
	};
}

/** What an import would do with a story — resolved once, used by preview AND apply. */
type Target =
	| { kind: "update"; id: string }
	| { kind: "create" }
	| { kind: "skip-duplicate"; item: FetchedWorkItem }
	| { kind: "duplicate-multi"; items: FetchedWorkItem[] };

/**
 * Decide what an import would do for a story, using the project index (one memoized
 * list, no per-item GETs). Shared by the dry-run preview and the apply so they never
 * diverge.
 *
 * A story with a `plane_id` is always an update. A story WITHOUT one is a create
 * UNLESS an item with the same identity already exists — matched by our `external_id`
 * OR by exact normalized title. Then it is a duplicate, handled by the guard (skip by
 * default; `--adopt-duplicates` links a single match; `--force-create` ignores the
 * collision). Routing external_id matches through the guard (not a silent update) is
 * what stops a second file from hijacking the first file's work item.
 */
async function resolveTarget(
	story: UserStory,
	project: { id: string; identifier: string },
	options: ImportOptions,
	getIndex: IndexProvider,
): Promise<Target> {
	if (story.planeId) {
		return { kind: "update", id: story.planeId };
	}

	const index = await getIndex(project.id, project.identifier);
	const externalId = makeExternalId(story.title);
	const candidates = new Map<string, FetchedWorkItem>();

	const externalMatch = index.items.find(
		(i) => i.externalId === externalId && i.externalSource === EXTERNAL_SOURCE,
	);
	if (externalMatch) {
		candidates.set(externalMatch.id, externalMatch);
	}
	for (const m of index.byNormalizedTitle.get(normalizeTitle(story.title)) ?? []) {
		if (!isCriterionExternalId(m.externalId)) {
			candidates.set(m.id, m);
		}
	}

	const list = [...candidates.values()];
	if (list.length === 0 || options.forceCreate) {
		return { kind: "create" };
	}
	if (options.adoptDuplicates) {
		return list.length > 1
			? { kind: "duplicate-multi", items: list }
			: { kind: "update", id: (list[0] as FetchedWorkItem).id };
	}
	return { kind: "skip-duplicate", item: list[0] as FetchedWorkItem };
}

/** Map a resolved target to a dry-run preview result (no writes), faithful to apply. */
function previewFromTarget(
	story: UserStory,
	target: Target,
	projectIdentifier: string,
	extraNote?: string,
): ImportResult {
	const ident = (item: FetchedWorkItem): string => `${projectIdentifier}-${item.sequenceId}`;
	const withNote = (base: string): string => [base, extraNote].filter(Boolean).join("; ");
	switch (target.kind) {
		case "create":
			return { story, action: "skipped", wouldAction: "create", note: extraNote };
		case "update":
			return { story, action: "skipped", wouldAction: "update", note: extraNote };
		case "skip-duplicate":
			return {
				story,
				action: "skipped",
				note: withNote(
					`duplicate of ${ident(target.item)}${
						target.item.stateName ? ` (${target.item.stateName})` : ""
					} — would skip; --adopt-duplicates to link`,
				),
			};
		case "duplicate-multi":
			return {
				story,
				action: "skipped",
				note: withNote(
					`${target.items.length} exact-title matches (${target.items
						.map(ident)
						.join(", ")}) — --adopt-duplicates ambiguous; set plane_id`,
				),
			};
	}
}

/**
 * Sync acceptance criteria to Plane sub-items (children of the story work item).
 * Each criterion is keyed by a positional external id so re-imports update in
 * place. A checked box maps to a completed-group state; an unchecked box to an
 * open (unstarted/backlog) state, so ticking in markdown moves the sub-item.
 */
async function syncCriteriaChildren(
	client: PlaneClient,
	resolver: Resolver,
	projectId: string,
	parentId: string,
	parentExternalId: string,
	criteria: AcceptanceCriterion[],
): Promise<void> {
	const completedStateId = await resolver.firstStateIdInGroups(projectId, ["completed"]);
	const openStateId = await resolver.firstStateIdInGroups(projectId, [
		"unstarted",
		"backlog",
		"started",
	]);

	for (let i = 0; i < criteria.length; i++) {
		const criterion = criteria[i] as AcceptanceCriterion;
		const childExternalId = `${parentExternalId}::ac${i}`;
		const stateId = criterion.checked ? completedStateId : openStateId;
		// Plane caps a work-item name at 255 chars; a long "close-condition"
		// criterion would otherwise 400. Keep the checkbox label short and preserve
		// the full text in the sub-item's description.
		const { name, body } = criterionNameAndBody(criterion.text);

		const existing = await findWorkItemByExternalId(
			client,
			projectId,
			childExternalId,
			EXTERNAL_SOURCE,
		);
		if (existing) {
			const update: UpdateWorkItemInput = { name, parent: parentId };
			if (body !== undefined) update.body = body;
			if (stateId) update.stateId = stateId;
			await updateWorkItem(client, projectId, existing.id, update);
		} else {
			const create: CreateWorkItemInput = {
				name,
				parent: parentId,
				externalId: childExternalId,
				externalSource: EXTERNAL_SOURCE,
			};
			if (body !== undefined) create.body = body;
			if (stateId) create.stateId = stateId;
			await createWorkItem(client, projectId, create);
		}
	}
}

/** Plane's maximum work-item name (title) length. */
const WORK_ITEM_NAME_MAX = 255;

/**
 * A criterion sub-item's name must fit Plane's 255-char title limit. If the
 * criterion text is longer, truncate the name and carry the full text in the
 * sub-item's description so nothing is lost.
 */
function criterionNameAndBody(text: string): { name: string; body?: string } {
	if (text.length <= WORK_ITEM_NAME_MAX) {
		return { name: text };
	}
	return { name: `${text.slice(0, WORK_ITEM_NAME_MAX - 5).trimEnd()}…`, body: text };
}

/** True for a criterion sub-item external id of the form `<parent>::ac<n>`. */
function isCriterionExternalId(externalId: string | undefined): boolean {
	return Boolean(externalId && /::ac\d+$/.test(externalId));
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Post a story's `comment:` evidence note once, keyed by a hash of the text so a
 * re-import doesn't duplicate it (and a changed note posts anew). No-op if unset.
 */
async function postEvidenceComment(
	client: PlaneClient,
	projectId: string,
	workItemId: string,
	comment: string | null,
): Promise<void> {
	if (!comment) {
		return;
	}
	const marker = `[planestories:comment:${createHash("sha256").update(comment).digest("hex").slice(0, 8)}]`;
	await ensureComment(
		client,
		projectId,
		workItemId,
		marker,
		`<p>${escapeHtml(comment)}</p><p><sub>${marker}</sub></p>`,
	);
}

/**
 * Build a deterministic external id from a story title, so a re-import without
 * write-back still matches the previously created work item.
 */
export function makeExternalId(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "story";
}

/**
 * The effective label NAMES an import would apply: story labels + config default
 * labels, plus the source label when one is configured/flagged. Used for the
 * content hash so a change to any of these (or toggling --source-label) is
 * detected. Mirrors the name set the write path resolves to IDs.
 */
function effectiveLabelNames(story: UserStory, options: ImportOptions): string[] {
	const labels = deduplicateLabels(story.labels, options.config.defaultLabels);
	const sourceLabel = options.sourceLabel ?? options.config.sourceLabel;
	if (sourceLabel && !labels.includes(sourceLabel)) {
		labels.push(sourceLabel);
	}
	return labels;
}

/**
 * Deduplicate labels from story and default labels.
 */
function deduplicateLabels(storyLabels: string[], defaultLabels: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const label of [...storyLabels, ...defaultLabels]) {
		if (!seen.has(label)) {
			seen.add(label);
			result.push(label);
		}
	}

	return result;
}

/**
 * Build an ImportSummary from an array of ImportResult.
 */
function buildSummary(results: ImportResult[]): ImportSummary {
	let created = 0;
	let updated = 0;
	let failed = 0;
	let skipped = 0;
	let unchanged = 0;

	for (const result of results) {
		switch (result.action) {
			case "created":
				created++;
				break;
			case "updated":
				updated++;
				break;
			case "failed":
				failed++;
				break;
			case "skipped":
				skipped++;
				break;
			case "unchanged":
				unchanged++;
				break;
		}
	}

	return {
		total: results.length,
		created,
		updated,
		failed,
		skipped,
		unchanged,
		results,
		labelsCreated: [],
		labelsSkipped: [],
		structureWarnings: [],
	};
}
