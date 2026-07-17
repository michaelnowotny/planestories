import { ARCHIVE_LABEL } from "../constants.ts";
import { ConfigError } from "../errors.ts";
import { serializeStories } from "../markdown/serializer.ts";
import type { PlaneClient } from "../plane/client.ts";
import { filterWorkItems, type WorkItemFilterInput } from "../plane/filters.ts";
import { type FetchedWorkItem, fetchWorkItems } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ExportFilters, FileFrontmatter, ResolvedConfig } from "../types.ts";
import { boardItemToStory, isCriterionChild } from "./board-story.ts";

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

	const items = await fetchWorkItems(client, project.id);

	const filterInput: WorkItemFilterInput = {};
	if (options.filters.issues && options.filters.issues.length > 0) {
		filterInput.identifiers = options.filters.issues;
	}
	if (options.filters.status) {
		filterInput.statusName = options.filters.status;
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

	// Group criterion sub-items by parent (from the full, unfiltered set).
	const childrenByParent = new Map<string, FetchedWorkItem[]>();
	if (options.syncCriteria) {
		for (const item of items) {
			if (isCriterionChild(item) && item.parent) {
				const list = childrenByParent.get(item.parent) ?? [];
				list.push(item);
				childrenByParent.set(item.parent, list);
			}
		}
	}

	// Stable ascending order so a round-tripped file matches creation order.
	let filtered = filterWorkItems(items, filterInput, project.identifier).sort(
		(a, b) => a.sequenceId - b.sequenceId,
	);
	if (options.syncCriteria) {
		filtered = filtered.filter((item) => !isCriterionChild(item));
	}
	// Hide archived items (label convention) unless explicitly included.
	if (!options.includeArchived) {
		filtered = filtered.filter(
			(item) => !item.labels.some((l) => l.toLowerCase() === ARCHIVE_LABEL),
		);
	}

	const stories = filtered.map((item) =>
		boardItemToStory(
			client,
			item,
			project.id,
			project.identifier,
			projectName,
			Boolean(options.syncCriteria),
			options.syncCriteria ? childrenByParent.get(item.id) : undefined,
		),
	);

	const frontmatter: FileFrontmatter = { project: projectName };

	const markdown = serializeStories(stories, frontmatter);
	await Bun.write(options.outputPath, markdown);

	return { count: stories.length, outputPath: options.outputPath };
}
