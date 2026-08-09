import { fetchRelationsWithSweep } from "../atlas/relations.ts";
import { ARCHIVE_LABEL } from "../constants.ts";
import { ConfigError, PlaneApiError } from "../errors.ts";
import { serializeStories } from "../markdown/serializer.ts";
import type { PlaneClient } from "../plane/client.ts";
import { filterWorkItems, type WorkItemFilterInput } from "../plane/filters.ts";
import { type FetchedWorkItem, fetchProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ExportFilters, FileFrontmatter, ResolvedConfig } from "../types.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import {
	boardItemToStory,
	descriptionHasCriteria,
	isCriterionChild,
	isOwnedCriterionChild,
	resolveStoryRelationIdentifiers,
} from "./board-story.ts";

export interface ExportOptions {
	config: ResolvedConfig;
	filters: ExportFilters;
	/** Project name to export from (overrides config.defaultProject). */
	project?: string;
	outputPath: string;
	/** Reconstruct acceptance criteria from sub-items instead of the description. */
	syncCriteria?: boolean;
	/** Include items carrying the archive label (excluded by default). */
	includeArchived?: boolean;
	/**
	 * Orphan worksheet: export ONLY non-epic stories with no board parent, with
	 * an epics directory as inert frontmatter comments — the file the operator
	 * fills `parent:` lines into and reviews as a diff.
	 */
	orphansOnly?: boolean;
}

/**
 * Export Plane work items to a markdown file.
 *
 * Plane work items are project-scoped, so a project must be resolvable from
 * --project, the export filter, or config.defaultProject.
 *
 * With syncCriteria, acceptance-criteria sub-items are folded back into their
 * parent story's checklist (and excluded from the story list).
 */
export async function exportStories(
	client: PlaneClient,
	options: ExportOptions,
): Promise<{ count: number; outputPath: string }> {
	const resolver = new Resolver(client);

	const projectName =
		options.project ?? options.filters.project ?? options.config.defaultProject ?? undefined;
	if (!projectName) {
		throw new ConfigError(
			"No project specified for export. Provide --project, a project filter, or set defaultProject in config.",
		);
	}

	const project = await resolver.resolveProject(projectName);

	// One list of the whole project; byId resolves parent UUIDs to identifiers.
	const index = await fetchProjectIndex(client, project.id, project.identifier);
	const items = index.items;

	const statusNames = [
		...(options.filters.status ? [options.filters.status] : []),
		...(options.filters.statuses ?? []),
	];
	const filterInput: WorkItemFilterInput = {};
	if (options.filters.issues && options.filters.issues.length > 0) {
		filterInput.identifiers = options.filters.issues;
	}
	if (statusNames.length > 0) {
		filterInput.statusNames = statusNames;
	}
	if (options.filters.openOnly) {
		filterInput.openOnly = true;
	}
	if (options.filters.assignee) {
		filterInput.assigneeEmail = options.filters.assignee;
	}
	if (options.filters.externalSource) {
		filterInput.externalSource = options.filters.externalSource;
	}
	if (options.filters.label) {
		filterInput.label = options.filters.label;
	}

	// Legacy criterion sub-items grouped by parent (from the full, unfiltered set).
	// Built ALWAYS — a parent that lacks a description checklist (a legacy
	// `--sync-criteria` board) still needs its criteria reconstructed from these.
	const criterionChildren = new Map<string, FetchedWorkItem[]>();
	for (const item of items) {
		if (isOwnedCriterionChild(item) && item.parent) {
			const list = criterionChildren.get(item.parent) ?? [];
			list.push(item);
			criterionChildren.set(item.parent, list);
		}
	}

	// An item that parents at least one NON-criterion child is an epic (planestories
	// models an epic as a parent work item). Criterion sub-items don't make a parent
	// an epic — those are a story's acceptance criteria.
	const isEpic = (item: FetchedWorkItem): boolean =>
		(index.childrenByParent.get(item.id) ?? []).some((c) => !isCriterionChild(c));

	// Stable ascending order so a round-tripped file matches creation order.
	let filtered = filterWorkItems(items, filterInput, project.identifier).sort(
		(a, b) => a.sequenceId - b.sequenceId,
	);
	// UNCONDITIONALLY exclude OWNED criterion children from the top-level story list
	// (Codex #8): once migration closes them they must never export as standalone
	// stories, and in the default model they are never their own story. Ownership-
	// scoped so another integration's `…::ac<n>` item is NOT dropped (Codex P1).
	filtered = filtered.filter((item) => !isOwnedCriterionChild(item));
	// Hide archived items (label convention) unless explicitly included.
	if (!options.includeArchived) {
		filtered = filtered.filter(
			(item) => !item.labels.some((l) => l.toLowerCase() === ARCHIVE_LABEL),
		);
	}
	// Orphan worksheet: only parentless non-epics (the stories a `parent:` line
	// would file into a cluster).
	if (options.orphansOnly) {
		filtered = filtered.filter((item) => !item.parent && !isEpic(item));
	}

	const parentIdentifier = (item: FetchedWorkItem): string | null => {
		if (!item.parent) return null;
		const p = index.byId.get(item.parent);
		return p ? `${project.identifier}-${p.sequenceId}` : null;
	};

	// Relations for every exported story, with the paced rate-limit sweep — but
	// FAIL-HARD if any lookup still fails: a file silently missing dependency
	// lines would REMOVE those relations from the board on re-import.
	const rel = await fetchRelationsWithSweep(client, project.id, filtered, 6);
	if (rel.failed > 0) {
		throw new PlaneApiError(
			`${rel.failed} relation lookup(s) failed even after the paced retry pass — export aborted ` +
				"(an exported file missing dependency lines would clobber board relations on re-import). Re-run.",
		);
	}

	const stories = await mapWithConcurrency(filtered, 6, async (item) => {
		const relations = rel.relationsById.get(item.id);
		if (!relations) {
			throw new PlaneApiError(`missing relations for ${project.identifier}-${item.sequenceId}`);
		}
		// Description-first (design §2): when the item already carries its criteria in
		// the description, that is authoritative — ignore any legacy children. Only a
		// legacy parent WITHOUT a description checklist folds its `::ac<n>` children.
		const children = descriptionHasCriteria(item) ? undefined : criterionChildren.get(item.id);
		return boardItemToStory(
			client,
			item,
			project.id,
			project.identifier,
			projectName,
			// Criteria now live in the story body; hash as criteria-in-body so
			// export->import round-trips warm against the default (non-sync) import.
			false,
			children,
			parentIdentifier(item),
			isEpic(item),
			resolveStoryRelationIdentifiers(relations, index, project.identifier),
		);
	});

	const frontmatter: FileFrontmatter = { project: projectName };

	// Worksheet header: every epic, as inert YAML comments the parser ignores.
	const frontmatterComments = options.orphansOnly
		? [
				"ORPHAN WORKSHEET - add `parent: <EPIC-ID>` to a story's yaml block to file it.",
				"Unknown parents FAIL the import for that story (never guessed).",
				"Epics directory:",
				...items
					.filter(isEpic)
					.sort((a, b) => a.sequenceId - b.sequenceId)
					.map(
						(ep) =>
							`  EPIC ${project.identifier}-${ep.sequenceId} - ${ep.name.replace(/\s+/g, " ")}`,
					),
			]
		: undefined;

	const markdown = serializeStories(stories, frontmatter, { frontmatterComments });
	await Bun.write(options.outputPath, markdown);

	return { count: stories.length, outputPath: options.outputPath };
}
