import { type AcceptanceCriterion, splitBody } from "../markdown/criteria.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import { type WriteBackUpdate, writeBackIds } from "../markdown/writer.ts";
import type { PlaneClient } from "../plane/client.ts";
import {
	type CreateWorkItemInput,
	createWorkItem,
	findWorkItemByExternalId,
	type UpdateWorkItemInput,
	updateWorkItem,
	type WorkItemRef,
} from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ImportResult, ImportSummary, ResolvedConfig, UserStory } from "../types.ts";

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

	for (const filePath of options.files) {
		const fileContent = await Bun.file(filePath).text();
		const parsed = parseMarkdownFile(fileContent, filePath);

		const writeBackUpdates: WriteBackUpdate[] = [];

		for (const story of parsed.stories) {
			const result = await processStory(client, resolver, story, options);
			results.push(result);

			// Write back identifiers for any story whose markdown didn't already
			// carry a plane_id (covers both fresh creates and external_id matches).
			if (
				story.planeId === null &&
				result.planeId &&
				result.planeIdentifier &&
				result.planeUrl &&
				(result.action === "created" || result.action === "updated")
			) {
				writeBackUpdates.push({
					title: story.title,
					planeId: result.planeId,
					planeIdentifier: result.planeIdentifier,
					planeUrl: result.planeUrl,
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
): Promise<ImportResult> {
	// Plain dry-run (no --check) validates parsing only and makes no network calls.
	if (options.dryRun && !options.check) {
		return { story, action: "skipped", wouldAction: story.planeId ? "update" : "create" };
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

		// Merge labels: story.labels + config.defaultLabels (deduplicated).
		// Never create labels during a dry-run, even with --create-labels.
		const allLabels = deduplicateLabels(story.labels, options.config.defaultLabels);
		const labelIds: string[] =
			allLabels.length > 0
				? await resolver.resolveLabelIds(
						project.id,
						allLabels,
						options.dryRun ? false : options.createLabels,
					)
				: [];

		const assigneeId = story.assignee
			? await resolver.resolveAssigneeId(project.id, story.assignee)
			: undefined;

		const stateId = story.status
			? await resolver.resolveStateId(project.id, story.status)
			: undefined;

		// Dry-run --check: everything above is read-only; report findings, no writes.
		if (options.dryRun) {
			const notes: string[] = [];
			if (story.assignee && !assigneeId) notes.push(`assignee "${story.assignee}" not found`);
			if (story.status && !stateId) notes.push(`status "${story.status}" not found`);
			return {
				story,
				action: "skipped",
				wouldAction: story.planeId ? "update" : "create",
				note: notes.join("; ") || undefined,
			};
		}

		// Opt-in source label: tag every created item, auto-creating the label
		// regardless of --create-labels. Off unless configured / flagged.
		const sourceLabel = options.sourceLabel ?? options.config.sourceLabel;
		if (sourceLabel) {
			const [sourceLabelId] = await resolver.resolveLabelIds(project.id, [sourceLabel], true);
			if (sourceLabelId && !labelIds.includes(sourceLabelId)) {
				labelIds.push(sourceLabelId);
			}
		}

		// When syncing criteria to sub-items, the parent description holds the
		// narrative only; the checklist lives as child work items.
		const { narrative, criteria } = splitBody(story.body);
		const bodyForParent = options.syncCriteria ? narrative : story.body;

		const input: CreateWorkItemInput = { name: story.title };
		if (bodyForParent) input.body = bodyForParent;
		if (labelIds.length > 0) input.labelIds = labelIds;
		if (assigneeId) input.assigneeId = assigneeId;
		if (story.priority !== null) input.priority = story.priority;
		if (story.estimate !== null) input.estimate = story.estimate;
		if (stateId) input.stateId = stateId;

		const externalId = makeExternalId(story.title);

		let ref: WorkItemRef;
		let action: "created" | "updated";
		if (story.planeId) {
			// 1. Update path: markdown already carries the work item UUID.
			ref = await updateWorkItem(client, project.id, story.planeId, input);
			action = "updated";
		} else {
			// 2. Idempotency: look up an item we previously created for this story.
			const existing = await findWorkItemByExternalId(
				client,
				project.id,
				externalId,
				EXTERNAL_SOURCE,
			);
			if (existing) {
				ref = await updateWorkItem(client, project.id, existing.id, input);
				action = "updated";
			} else {
				// 3. Create path.
				input.externalId = externalId;
				input.externalSource = EXTERNAL_SOURCE;
				ref = await createWorkItem(client, project.id, input);
				action = "created";
			}
		}

		if (options.syncCriteria && criteria.length > 0) {
			await syncCriteriaChildren(client, resolver, project.id, ref.id, externalId, criteria);
		}

		return makeResult(client, story, project.id, project.identifier, ref, action);
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
): ImportResult {
	return {
		story,
		action,
		planeId: ref.id,
		planeIdentifier: `${projectIdentifier}-${ref.sequenceId}`,
		planeUrl: client.workItemWebUrl(projectId, ref.id),
	};
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

		const existing = await findWorkItemByExternalId(
			client,
			projectId,
			childExternalId,
			EXTERNAL_SOURCE,
		);
		if (existing) {
			const update: UpdateWorkItemInput = { name: criterion.text, parent: parentId };
			if (stateId) update.stateId = stateId;
			await updateWorkItem(client, projectId, existing.id, update);
		} else {
			const create: CreateWorkItemInput = {
				name: criterion.text,
				parent: parentId,
				externalId: childExternalId,
				externalSource: EXTERNAL_SOURCE,
			};
			if (stateId) create.stateId = stateId;
			await createWorkItem(client, projectId, create);
		}
	}
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
		}
	}

	return {
		total: results.length,
		created,
		updated,
		failed,
		skipped,
		results,
		labelsCreated: [],
		labelsSkipped: [],
	};
}
