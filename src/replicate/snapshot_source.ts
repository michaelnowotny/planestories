import { deriveWebBaseUrl, type PlaneIssueRelations } from "../plane/client.ts";
import type { ProjectSnapshot, SnapshotRelations } from "./types.ts";

/**
 * A read-only stand-in for `PlaneClient`, backed by a snapshot file.
 *
 * The read-only commands — `doctor`, and in time atlas/export/packet/epic —
 * enumerate exactly what a snapshot already contains: items, hierarchy, states,
 * labels, relations, comments. Running them against a file instead of an instance
 * costs ZERO API calls, works offline, and is the only way to inspect a board whose
 * instance is rate-limiting you (a real `doctor` run produced no output for ten
 * minutes and then nothing, because its ~800-request sweep could not complete).
 *
 * It also turns the nightly backups into something you USE rather than something you
 * hope never to need.
 *
 * The honesty requirement: a command reading a snapshot must SAY SO and print the
 * snapshot's `takenAt`. A stale answer presented as a live one is worse than no
 * answer, and the whole point of this tool is not doing that.
 */
export class SnapshotSource {
	readonly dialect: "issues" | "work-items";
	readonly takenAt: string;
	readonly projectId: string;
	readonly projectIdentifier: string;
	readonly projectName: string;
	private readonly snapshot: ProjectSnapshot;
	readonly workspaceSlug: string;
	private readonly webBaseUrl: string;
	private readonly stateById: Map<string, { id: string; name: string; group: string }>;
	private readonly labelById: Map<string, { id: string; name: string }>;

	constructor(snapshot: ProjectSnapshot) {
		this.snapshot = snapshot;
		this.dialect = snapshot.source.dialect;
		this.takenAt = snapshot.takenAt;
		this.projectId = snapshot.source.projectId;
		this.projectIdentifier = snapshot.project.identifier;
		this.projectName = snapshot.project.name;
		this.workspaceSlug = snapshot.source.workspaceSlug;
		this.webBaseUrl = deriveWebBaseUrl(snapshot.source.baseUrl);
		this.stateById = new Map(
			snapshot.states.map((state) => [
				state.id,
				{ id: state.id, name: state.name, group: state.group },
			]),
		);
		this.labelById = new Map(
			snapshot.labels.map((label) => [label.id, { id: label.id, name: label.name }]),
		);
	}

	/** Never paced: nothing here touches the network. */
	concurrency(): number | undefined {
		return undefined;
	}

	pacingSummary(): string | undefined {
		return undefined;
	}

	async listProjects<T>(): Promise<T[]> {
		return [
			{
				id: this.projectId,
				identifier: this.projectIdentifier,
				name: this.projectName,
			},
		] as T[];
	}

	async listStates<T>(): Promise<T[]> {
		return this.snapshot.states as unknown as T[];
	}

	async listLabels<T>(): Promise<T[]> {
		return this.snapshot.labels as unknown as T[];
	}

	async listProjectMembers<T>(): Promise<T[]> {
		return this.snapshot.members as unknown as T[];
	}

	async listWorkspaceMembers<T>(): Promise<T[]> {
		return this.snapshot.members as unknown as T[];
	}

	/**
	 * Rebuild the raw Plane row shape the work-item index normalizes, so every
	 * consumer downstream is byte-identical to a live read. Archived items are
	 * included: a snapshot's whole point is that it is the complete picture.
	 */
	async listWorkItems<T>(): Promise<T[]> {
		return this.snapshot.items.map((item) => {
			const state = item.stateId ? this.stateById.get(item.stateId) : undefined;
			return {
				id: item.id,
				sequence_id: item.sequenceId,
				name: item.name,
				description_html: item.descriptionHtml ?? undefined,
				priority: item.priority ?? undefined,
				point: item.point ?? undefined,
				state: state ? { id: state.id, name: state.name, group: state.group } : undefined,
				parent: item.parentId ?? undefined,
				labels: item.labelIds
					.map((id) => this.labelById.get(id))
					.filter((label): label is { id: string; name: string } => label !== undefined),
				assignees: [],
				external_source: item.externalSource ?? undefined,
				external_id: item.externalId ?? undefined,
				created_at: item.createdAt ?? undefined,
				updated_at: item.updatedAt ?? undefined,
				completed_at: item.completedAt ?? undefined,
				// A real timestamp or nothing — never a boolean standing in for a date,
				// which a later consumer could try to parse.
				archived_at: item.archived ? (item.updatedAt ?? null) : undefined,
			};
		}) as T[];
	}

	async listArchivedWorkItems<T>(): Promise<T[] | null> {
		// Archived items are already inside listWorkItems (see above); returning them
		// again would double-count. An empty list is the truthful answer here, and it
		// is NOT the "endpoint unavailable" null — a snapshot always knows.
		return [] as T[];
	}

	async getRelations(_projectId: string, workItemId: string): Promise<PlaneIssueRelations> {
		return expandRelations(this.snapshot.relations[workItemId]);
	}

	async listWorkItemComments<T>(_projectId: string, workItemId: string): Promise<T[]> {
		return (this.snapshot.comments[workItemId] ?? []) as unknown as T[];
	}

	/**
	 * Browser URLs are derived from the snapshot's OWN source instance, so a packet
	 * built offline still links back to the board the data came from.
	 */
	workItemWebUrl(projectId: string, workItemId: string): string {
		return `${this.webBaseUrl}/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}`;
	}

	projectWebUrl(projectId: string): string {
		return `${this.webBaseUrl}/${this.workspaceSlug}/projects/${projectId}/issues`;
	}

	/** One line every consuming command must print, so a stale answer is never mistaken for a live one. */
	provenance(): string {
		return `Read from snapshot (taken ${this.takenAt}) — NOT live. No API calls were made.`;
	}
}

function expandRelations(relations: SnapshotRelations | undefined): PlaneIssueRelations {
	return {
		blocking: relations?.blocking ?? [],
		blocked_by: relations?.blocked_by ?? [],
		relates_to: relations?.relates_to ?? [],
		duplicate: [],
		start_before: [],
		start_after: [],
		finish_before: [],
		finish_after: [],
	};
}
