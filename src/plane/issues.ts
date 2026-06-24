import { PlaneApiError } from "../errors.ts";
import { htmlToMarkdown, markdownToHtml } from "../markdown/html.ts";
import type { PlanePriority } from "../types.ts";
import type { PlaneClient } from "./client.ts";

export interface CreateWorkItemInput {
	name: string;
	/** Raw markdown body; converted to HTML for Plane's description_html. */
	body?: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: PlanePriority;
	/** Story points -> Plane's `point` field. */
	estimate?: number;
	stateId?: string;
	externalId?: string;
	externalSource?: string;
	/** Parent work item UUID (used for acceptance-criteria sub-items). */
	parent?: string;
}

export type UpdateWorkItemInput = Omit<CreateWorkItemInput, "externalId" | "externalSource">;

export interface WorkItemRef {
	id: string;
	sequenceId: number;
}

/** Raw Plane work item as returned by create/list (subset we use). */
interface RawWorkItem {
	id: string;
	sequence_id: number;
}

/** A work item fetched for export, with related names resolved via `expand`. */
export interface FetchedWorkItem {
	id: string;
	sequenceId: number;
	name: string;
	/** Description as markdown (converted from Plane's description_html). */
	description: string | undefined;
	priority: PlanePriority | undefined;
	estimate: number | undefined;
	stateName: string | undefined;
	assigneeEmail: string | undefined;
	assigneeDisplayName: string | undefined;
	labels: string[];
	externalSource: string | undefined;
	externalId: string | undefined;
	/** Parent work item UUID, if this item is a sub-item. */
	parent: string | undefined;
	/** State group: backlog | unstarted | started | completed | cancelled. */
	stateGroup: string | undefined;
}

/** Build the Plane work item request body shared by create and update. */
function buildBody(input: CreateWorkItemInput | UpdateWorkItemInput): Record<string, unknown> {
	const body: Record<string, unknown> = { name: input.name };

	if (input.body !== undefined) {
		const html = markdownToHtml(input.body);
		if (html) {
			body.description_html = html;
		}
	}
	if (input.labelIds !== undefined) {
		body.labels = input.labelIds;
	}
	if (input.assigneeId !== undefined) {
		body.assignees = [input.assigneeId];
	}
	if (input.priority !== undefined) {
		body.priority = input.priority;
	}
	if (input.estimate !== undefined) {
		body.point = input.estimate;
	}
	if (input.stateId !== undefined) {
		body.state = input.stateId;
	}
	if (input.parent !== undefined) {
		body.parent = input.parent;
	}
	if ("externalId" in input && input.externalId !== undefined) {
		body.external_id = input.externalId;
	}
	if ("externalSource" in input && input.externalSource !== undefined) {
		body.external_source = input.externalSource;
	}

	return body;
}

/** Create a new work item in a project. */
export async function createWorkItem(
	client: PlaneClient,
	projectId: string,
	input: CreateWorkItemInput,
): Promise<WorkItemRef> {
	try {
		const item = await client.createWorkItem<RawWorkItem>(projectId, buildBody(input));
		return { id: item.id, sequenceId: item.sequence_id };
	} catch (error) {
		if (error instanceof PlaneApiError) {
			throw error;
		}
		throw new PlaneApiError(
			`Failed to create work item: "${input.name}" - ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Update an existing work item by its UUID. */
export async function updateWorkItem(
	client: PlaneClient,
	projectId: string,
	workItemId: string,
	input: UpdateWorkItemInput,
): Promise<WorkItemRef> {
	try {
		const item = await client.updateWorkItem<RawWorkItem>(projectId, workItemId, buildBody(input));
		return { id: item.id, sequenceId: item.sequence_id };
	} catch (error) {
		if (error instanceof PlaneApiError) {
			throw error;
		}
		throw new PlaneApiError(
			`Failed to update work item: "${workItemId}" - ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * Look up a work item by its external id within a project, used to make
 * imports idempotent. Returns null when no match exists.
 */
export async function findWorkItemByExternalId(
	client: PlaneClient,
	projectId: string,
	externalId: string,
	externalSource: string,
): Promise<WorkItemRef | null> {
	// Plane's external_id filter returns a single object on a hit (or a 404 →
	// null on a miss), but defend against a paginated shape just in case.
	const data = await client.findWorkItemByExternalId<RawWorkItem | { results?: RawWorkItem[] }>(
		projectId,
		externalId,
		externalSource,
	);
	if (!data) {
		return null;
	}
	const match =
		"results" in data && Array.isArray(data.results) ? data.results[0] : (data as RawWorkItem);
	return match?.id ? { id: match.id, sequenceId: match.sequence_id } : null;
}

/** Fetch work items in a project for export, resolving related names via `expand`. */
export async function fetchWorkItems(
	client: PlaneClient,
	projectId: string,
	query: Record<string, string | number | boolean | undefined> = {},
): Promise<FetchedWorkItem[]> {
	const raw = await client.listWorkItems<Record<string, unknown>>(projectId, {
		expand: "state,assignees,labels",
		...query,
	});
	return raw.map(normalizeFetched);
}

function normalizeFetched(item: Record<string, unknown>): FetchedWorkItem {
	const state = item.state as { name?: string; group?: string } | string | undefined;
	const stateName = state && typeof state === "object" ? state.name : undefined;
	const stateGroup = state && typeof state === "object" ? state.group : undefined;

	const assignees = (item.assignees as Array<Record<string, unknown>> | undefined) ?? [];
	const firstAssignee = assignees[0];

	const labels = (item.labels as Array<Record<string, unknown> | string> | undefined) ?? [];
	const labelNames = labels
		.map((l) => (typeof l === "object" ? (l.name as string) : undefined))
		.filter((n): n is string => typeof n === "string");

	const priorityRaw = item.priority as string | undefined;
	const priority =
		priorityRaw && priorityRaw !== "none" ? (priorityRaw as PlanePriority) : undefined;

	const estimateRaw = item.point;
	const estimate = typeof estimateRaw === "number" ? estimateRaw : undefined;

	return {
		id: item.id as string,
		sequenceId: item.sequence_id as number,
		name: item.name as string,
		description: htmlToMarkdown(item.description_html as string | undefined) || undefined,
		priority,
		estimate,
		stateName,
		assigneeEmail: firstAssignee?.email as string | undefined,
		assigneeDisplayName: firstAssignee?.display_name as string | undefined,
		labels: labelNames,
		externalSource: (item.external_source as string) || undefined,
		externalId: (item.external_id as string) || undefined,
		parent: (item.parent as string) || undefined,
		stateGroup,
	};
}
