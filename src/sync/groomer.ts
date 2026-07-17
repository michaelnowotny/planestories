import { ConfigError } from "../errors.ts";
import type { PlaneClient } from "../plane/client.ts";
import {
	ensureComment,
	type FetchedWorkItem,
	fetchProjectIndex,
	updateWorkItem,
} from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { isCriterionChild } from "./board-story.ts";
import { EXTERNAL_SOURCE } from "./importer.ts";

/** Marker embedded in the auto-close comment so re-runs don't post duplicates. */
export const GROOM_CLOSE_MARKER = "[planestories:auto-closed-with-parent]";

/** State groups that count as "done" for the purpose of cascading closure. */
const COMPLETED_GROUPS = new Set(["completed", "cancelled"]);

export interface GroomOptions {
	config: ResolvedConfig;
	project?: string;
	/** Apply changes. Without this, groom is a read-only report (dry-run). */
	apply?: boolean;
}

export interface GroomItemRef {
	identifier: string;
	title: string;
	parentIdentifier?: string;
}

export interface GroomReport {
	project: string;
	/** Open criterion sub-items whose parent is done/cancelled — closed when applied. */
	orphanedCriteria: GroomItemRef[];
	/** How many were actually closed (0 in dry-run). */
	closed: number;
	/** How many auto-close comments were posted (idempotent; 0 in dry-run). */
	commentsPosted: number;
	/** Report-only: story titles that appear on more than one work item. */
	duplicateTitles: Array<{ title: string; identifiers: string[] }>;
	/** Report-only: open criterion sub-items whose parent no longer exists. */
	parentlessCriteria: GroomItemRef[];
	applied: boolean;
}

/**
 * Reconcile a project (board→ tidy). v1 scope:
 *  a. CLOSE orphaned criterion sub-items — an open `::ac<n>` sub-item created by
 *     planestories whose PARENT is done/cancelled. **Only criterion sub-items are
 *     ever closed** (external_source planestories + `::ac<n>` external_id); a real
 *     child STORY of a done epic is never touched.
 *  b. REPORT duplicate-title story pairs.
 *  c. REPORT open criterion sub-items whose parent no longer exists.
 * Reverse-sync (board→file checkbox ticking) is deferred to a later slice.
 *
 * Dry-run by default; pass `apply` to actually close (a).
 */
export async function groom(client: PlaneClient, options: GroomOptions): Promise<GroomReport> {
	const resolver = new Resolver(client);
	const projectName = options.project ?? options.config.defaultProject ?? undefined;
	if (!projectName) {
		throw new ConfigError(
			"No project specified for groom. Provide --project or set defaultProject in config.",
		);
	}
	const project = await resolver.resolveProject(projectName);
	const index = await fetchProjectIndex(client, project.id, project.identifier);

	const ident = (item: FetchedWorkItem): string => `${project.identifier}-${item.sequenceId}`;
	const isDone = (item: FetchedWorkItem): boolean =>
		!!item.stateGroup && COMPLETED_GROUPS.has(item.stateGroup);

	const toClose: FetchedWorkItem[] = [];
	const parentlessItems: FetchedWorkItem[] = [];

	for (const item of index.items) {
		// CRITICAL: only OUR criterion sub-items — never story children of a done epic.
		if (!isCriterionChild(item) || item.externalSource !== EXTERNAL_SOURCE) {
			continue;
		}
		if (isDone(item)) {
			continue; // already closed
		}
		if (!item.parent) {
			continue;
		}
		const parent = index.byId.get(item.parent);
		if (!parent) {
			parentlessItems.push(item);
			continue;
		}
		if (isDone(parent)) {
			toClose.push(item);
		}
	}

	// Duplicate-title report (stories only; criterion sub-item names are AC text).
	const duplicateTitles: Array<{ title: string; identifiers: string[] }> = [];
	for (const items of index.byNormalizedTitle.values()) {
		const stories = items.filter((i) => !isCriterionChild(i));
		if (stories.length > 1) {
			duplicateTitles.push({
				title: stories[0]?.name ?? "",
				identifiers: stories.map(ident),
			});
		}
	}

	let closed = 0;
	let commentsPosted = 0;
	if (options.apply && toClose.length > 0) {
		const completedStateId = await resolver.firstStateIdInGroups(project.id, ["completed"]);
		if (!completedStateId) {
			throw new ConfigError(
				`No completed-group state found in project ${project.identifier} to close sub-items into.`,
			);
		}
		for (const item of toClose) {
			await updateWorkItem(client, project.id, item.id, { stateId: completedStateId });
			const outcome = await ensureComment(
				client,
				project.id,
				item.id,
				GROOM_CLOSE_MARKER,
				`<p>Auto-closed with parent by planestories. ${GROOM_CLOSE_MARKER}</p>`,
			);
			if (outcome === "posted") {
				commentsPosted++;
			}
			closed++;
		}
	}

	const parentIdentifierOf = (item: FetchedWorkItem): string | undefined => {
		const parent = item.parent ? index.byId.get(item.parent) : undefined;
		return parent ? ident(parent) : undefined;
	};

	return {
		project: project.identifier,
		orphanedCriteria: toClose.map((i) => ({
			identifier: ident(i),
			title: i.name,
			parentIdentifier: parentIdentifierOf(i),
		})),
		closed,
		commentsPosted,
		duplicateTitles,
		parentlessCriteria: parentlessItems.map((i) => ({ identifier: ident(i), title: i.name })),
		applied: Boolean(options.apply),
	};
}
