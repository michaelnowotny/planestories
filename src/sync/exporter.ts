import { ConfigError } from "../errors.ts";
import { serializeStories } from "../markdown/serializer.ts";
import type { PlaneClient } from "../plane/client.ts";
import { filterWorkItems, type WorkItemFilterInput } from "../plane/filters.ts";
import { type FetchedWorkItem, fetchWorkItems } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ExportFilters, FileFrontmatter, ResolvedConfig, UserStory } from "../types.ts";

export interface ExportOptions {
	config: ResolvedConfig;
	filters: ExportFilters;
	/** Project name to export from (overrides config.defaultProject). */
	project?: string;
	outputPath: string;
}

/**
 * Export Plane work items to a markdown file.
 *
 * Plane work items are project-scoped, so a project must be resolvable from
 * --project, the export filter, or config.defaultProject.
 *
 * Algorithm:
 * 1. Resolve the project (required)
 * 2. Fetch work items for the project (related names expanded)
 * 3. Apply client-side filters (identifiers, status, assignee)
 * 4. Convert to UserStory[] and serialize to markdown
 * 5. Write to outputPath
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

	const filtered = filterWorkItems(items, filterInput, project.identifier);

	const stories = filtered.map((item) =>
		workItemToUserStory(client, item, project.id, project.identifier, projectName),
	);

	const frontmatter: FileFrontmatter = { project: projectName };

	const markdown = serializeStories(stories, frontmatter);
	await Bun.write(options.outputPath, markdown);

	return { count: stories.length, outputPath: options.outputPath };
}

/**
 * Convert a fetched Plane work item to a UserStory.
 */
function workItemToUserStory(
	client: PlaneClient,
	item: FetchedWorkItem,
	projectId: string,
	projectIdentifier: string,
	projectName: string,
): UserStory {
	return {
		title: item.name,
		planeId: item.id,
		planeIdentifier: `${projectIdentifier}-${item.sequenceId}`,
		planeUrl: client.workItemWebUrl(projectId, item.id),
		priority: item.priority ?? null,
		labels: item.labels,
		estimate: item.estimate ?? null,
		assignee: item.assigneeEmail ?? item.assigneeDisplayName ?? null,
		status: item.stateName ?? null,
		body: item.description ?? "",
		project: projectName,
	};
}
