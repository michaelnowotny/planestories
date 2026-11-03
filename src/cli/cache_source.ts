import { deriveWebBaseUrl, type PlaneIssueRelations } from "../plane/client.ts";
import type { BoardCache, BoardCacheRecord, BoardCacheRelationSets } from "./board_cache.ts";

/**
 * A read-only stand-in for `PlaneClient`, backed by a board cache that captured
 * work-item records and relations.
 *
 * packet, epic, and doctor need narrative HTML, criterion children, and relation
 * targets the atlas graph does not keep. Answering them from the graph would
 * publish a brief or a doctor report that is missing those facts. This source
 * rebuilds the raw rows `normalizeFetched` already understands, so the markdown
 * conversion is the same one a live list uses.
 */
export class CacheSource {
	readonly fetchedAt: string;
	private readonly cache: BoardCache;
	private readonly records: BoardCacheRecord[];
	private readonly relations: Record<string, BoardCacheRelationSets>;
	private readonly knownIds: Set<string>;
	private readonly webBaseUrl: string;

	constructor(cache: BoardCache) {
		if (!cache.records || !cache.relations) {
			throw new Error(
				`Board cache for "${cache.project.name}" has no work-item records. Refusing to answer from the dependency graph.`,
			);
		}
		this.cache = cache;
		this.fetchedAt = cache.fetchedAt;
		this.records = cache.records;
		this.relations = cache.relations;
		this.knownIds = new Set(cache.records.map((record) => record.id));
		this.webBaseUrl = deriveWebBaseUrl(cache.instance.baseUrl);
	}

	/** Nothing here touches the network. */
	concurrency(): number | undefined {
		return undefined;
	}

	pacingSummary(): string | undefined {
		return undefined;
	}

	async listProjects<T>(): Promise<T[]> {
		return [
			{
				id: this.cache.project.id,
				identifier: this.cache.project.identifier,
				name: this.cache.project.name,
			},
		] as T[];
	}

	async listWorkItems<T>(projectId: string): Promise<T[]> {
		this.assertProject(projectId);
		return this.records.map((record) => rawWorkItem(record)) as T[];
	}

	async listArchivedWorkItems<T>(projectId: string): Promise<T[]> {
		// The board index this cache was built from does not include archived
		// items. An empty list is that fact, not "the endpoint is missing".
		this.assertProject(projectId);
		return [] as T[];
	}

	async getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations> {
		this.assertProject(projectId);
		if (!this.knownIds.has(workItemId)) {
			throw new Error(
				`Board cache has no work item ${workItemId}. Refusing to report it as having no relations.`,
			);
		}
		return expandRelations(this.relations[workItemId]);
	}

	workItemWebUrl(projectId: string, workItemId: string): string {
		return `${this.webBaseUrl}/${this.cache.instance.workspaceSlug}/projects/${projectId}/issues/${workItemId}`;
	}

	provenance(): string {
		return `Read from board cache (fetched ${this.fetchedAt}) — NOT live. No API calls were made.`;
	}

	private assertProject(projectId: string): void {
		if (projectId !== this.cache.project.id) {
			throw new Error(
				`Board cache is for project ${this.cache.project.id}, not ${projectId}. Refusing to answer with the wrong board.`,
			);
		}
	}
}

function rawWorkItem(record: BoardCacheRecord): Record<string, unknown> {
	const row: Record<string, unknown> = {
		id: record.id,
		sequence_id: record.sequenceId,
		name: record.name,
		assignees: record.assignee
			? [
					{
						id: record.assignee.id ?? undefined,
						email: record.assignee.email ?? undefined,
						display_name: record.assignee.displayName ?? undefined,
					},
				]
			: [],
		labels: record.labelNames.map((name) => ({ name })),
	};
	if (record.descriptionHtml !== null) row.description_html = record.descriptionHtml;
	if (record.priority !== null) row.priority = record.priority;
	if (record.point !== null) row.point = record.point;
	if (record.stateName !== null || record.stateGroup !== null) {
		row.state = {
			...(record.stateName !== null ? { name: record.stateName } : {}),
			...(record.stateGroup !== null ? { group: record.stateGroup } : {}),
		};
	}
	if (record.parentId !== null) row.parent = record.parentId;
	if (record.externalSource !== null) row.external_source = record.externalSource;
	if (record.externalId !== null) row.external_id = record.externalId;
	if (record.createdAt !== null) row.created_at = record.createdAt;
	if (record.updatedAt !== null) row.updated_at = record.updatedAt;
	return row;
}

function expandRelations(sets: BoardCacheRelationSets | undefined): PlaneIssueRelations {
	return {
		blocking: [...(sets?.blocking ?? [])],
		blocked_by: [...(sets?.blocked_by ?? [])],
		relates_to: [...(sets?.relates_to ?? [])],
		duplicate: [...(sets?.duplicate ?? [])],
		start_before: [...(sets?.start_before ?? [])],
		start_after: [...(sets?.start_after ?? [])],
		finish_before: [...(sets?.finish_before ?? [])],
		finish_after: [...(sets?.finish_after ?? [])],
	};
}
