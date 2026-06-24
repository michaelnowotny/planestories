import { ARCHIVE_LABEL } from "../constants.ts";
import { ConfigError } from "../errors.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import { clearWriteBack } from "../markdown/writer.ts";
import type { PlaneClient } from "../plane/client.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { EXTERNAL_SOURCE } from "./importer.ts";

export interface DeleteOptions {
	config: ResolvedConfig;
	/** File-scoped mode: delete the work items referenced by these files' plane_ids. */
	files?: string[];
	project?: string;
	/** External-source-scoped mode: delete stamped items in a project. */
	externalSource?: string;
	/** Archive (recoverable) by applying the archive label instead of hard deleting. */
	archive?: boolean;
	/** Label name used for archiving (default "archived"). */
	archiveLabel?: string;
	dryRun?: boolean;
	/** Must be true to actually delete; otherwise the plan is shown but nothing happens. */
	confirmed?: boolean;
	/** Skip clearing plane_* back out of files (file mode only). */
	noWriteBack?: boolean;
}

export interface DeleteTarget {
	projectId: string;
	projectName: string;
	workItemId: string;
	/** Human label for display (identifier or title). */
	label: string;
	/** File + story title for write-back clearing (file mode only). */
	file?: string;
	storyTitle?: string;
}

export interface DeleteResult {
	target: DeleteTarget;
	action: "deleted" | "archived" | "failed" | "skipped";
	error?: string;
}

export interface DeleteSummary {
	results: DeleteResult[];
	planned: number;
	deleted: number;
	archived: number;
	failed: number;
	dryRun: boolean;
	confirmed: boolean;
}

interface RawListItem {
	id: string;
	sequence_id: number;
	name: string;
	external_source?: string | null;
}

/**
 * Delete (or archive) Plane work items, scoped either to markdown files'
 * plane_ids or to an external_source within a project. Never deletes an entire
 * project blindly; refuses to run without files or an external_source scope.
 *
 * Nothing is deleted unless `confirmed` is true and `dryRun` is false.
 */
export async function deleteStories(
	client: PlaneClient,
	options: DeleteOptions,
): Promise<DeleteSummary> {
	const resolver = new Resolver(client);
	const targets = await collectTargets(client, resolver, options);

	const willDelete = options.confirmed === true && options.dryRun !== true;

	const archiveLabel = options.archiveLabel || ARCHIVE_LABEL;

	const results: DeleteResult[] = [];
	for (const target of targets) {
		if (!willDelete) {
			results.push({ target, action: "skipped" });
			continue;
		}
		try {
			if (options.archive) {
				await archiveTarget(client, resolver, target, archiveLabel);
				results.push({ target, action: "archived" });
			} else {
				await client.deleteWorkItem(target.projectId, target.workItemId);
				results.push({ target, action: "deleted" });
			}
		} catch (error) {
			results.push({
				target,
				action: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// File mode: clear plane_* only after a HARD delete (archived items still exist).
	if (willDelete && !options.archive && !options.noWriteBack && options.files?.length) {
		await clearFiles(results);
	}

	return summarize(results, options);
}

async function collectTargets(
	client: PlaneClient,
	resolver: Resolver,
	options: DeleteOptions,
): Promise<DeleteTarget[]> {
	if (options.files && options.files.length > 0) {
		return collectFromFiles(resolver, options);
	}
	if (options.externalSource) {
		return collectFromExternalSource(client, resolver, options);
	}
	throw new ConfigError(
		"delete requires either markdown files or --external-source with --project. " +
			"Refusing to delete an entire project.",
	);
}

async function collectFromFiles(
	resolver: Resolver,
	options: DeleteOptions,
): Promise<DeleteTarget[]> {
	const targets: DeleteTarget[] = [];
	for (const file of options.files ?? []) {
		const content = await Bun.file(file).text();
		const parsed = parseMarkdownFile(content, file);
		for (const story of parsed.stories) {
			if (!story.planeId) {
				continue;
			}
			const projectName = story.project ?? options.project ?? options.config.defaultProject;
			if (!projectName) {
				throw new ConfigError(
					`No project for story "${story.title}" in ${file}; set one in frontmatter, --project, or defaultProject.`,
				);
			}
			const project = await resolver.resolveProject(projectName);
			targets.push({
				projectId: project.id,
				projectName,
				workItemId: story.planeId,
				label: story.planeIdentifier ?? story.planeId,
				file,
				storyTitle: story.title,
			});
		}
	}
	return targets;
}

async function collectFromExternalSource(
	client: PlaneClient,
	resolver: Resolver,
	options: DeleteOptions,
): Promise<DeleteTarget[]> {
	const projectName = options.project ?? options.config.defaultProject;
	if (!projectName) {
		throw new ConfigError("--external-source requires --project (or a configured defaultProject).");
	}
	const source = options.externalSource === "" ? EXTERNAL_SOURCE : options.externalSource;
	const project = await resolver.resolveProject(projectName);

	// List all and filter client-side — robust regardless of server-side filter support.
	const items = await client.listWorkItems<RawListItem>(project.id);
	return items
		.filter((item) => item.external_source === source)
		.map((item) => ({
			projectId: project.id,
			projectName,
			workItemId: item.id,
			label: `${project.identifier}-${item.sequence_id} ${item.name}`,
		}));
}

/**
 * Archive a work item by adding the archive label, preserving existing labels.
 * Recoverable (remove the label) and works on any state, unlike Plane's native
 * archive which is restricted to completed/cancelled items.
 */
async function archiveTarget(
	client: PlaneClient,
	resolver: Resolver,
	target: DeleteTarget,
	archiveLabel: string,
): Promise<void> {
	const [archiveLabelId] = await resolver.resolveLabelIds(target.projectId, [archiveLabel], true);
	if (!archiveLabelId) {
		return;
	}
	const item = await client.getWorkItem<{ labels?: Array<string | { id: string }> }>(
		target.projectId,
		target.workItemId,
	);
	const current = (item.labels ?? []).map((l) => (typeof l === "string" ? l : l.id));
	if (current.includes(archiveLabelId)) {
		return; // already archived
	}
	await client.updateWorkItem(target.projectId, target.workItemId, {
		labels: [...current, archiveLabelId],
	});
}

async function clearFiles(results: DeleteResult[]): Promise<void> {
	// Group successfully-removed story titles by file.
	const byFile = new Map<string, string[]>();
	for (const r of results) {
		if (
			(r.action === "deleted" || r.action === "archived") &&
			r.target.file &&
			r.target.storyTitle
		) {
			const list = byFile.get(r.target.file) ?? [];
			list.push(r.target.storyTitle);
			byFile.set(r.target.file, list);
		}
	}
	for (const [file, titles] of byFile) {
		const content = await Bun.file(file).text();
		await Bun.write(file, clearWriteBack(content, titles));
	}
}

function summarize(results: DeleteResult[], options: DeleteOptions): DeleteSummary {
	let deleted = 0;
	let archived = 0;
	let failed = 0;
	for (const r of results) {
		if (r.action === "deleted") deleted++;
		else if (r.action === "archived") archived++;
		else if (r.action === "failed") failed++;
	}
	return {
		results,
		planned: results.length,
		deleted,
		archived,
		failed,
		dryRun: options.dryRun === true,
		confirmed: options.confirmed === true,
	};
}
