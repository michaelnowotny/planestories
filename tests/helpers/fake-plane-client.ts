import type { PlaneClient } from "../../src/plane/client.ts";

export interface FakeProject {
	id: string;
	name: string;
	identifier: string;
}

export interface FakeNamed {
	id: string;
	name: string;
	/** State group (states only): backlog | unstarted | started | completed | cancelled. */
	group?: string;
}

export interface RecordedCall {
	method: string;
	args: unknown[];
}

export interface FakeData {
	projects?: FakeProject[];
	states?: Record<string, FakeNamed[]>;
	labels?: Record<string, FakeNamed[]>;
	members?: Record<string, Array<Record<string, unknown>>>;
	/** Work items keyed by project id, returned by listWorkItems. */
	workItems?: Record<string, Array<Record<string, unknown>>>;
	/** Existing comments keyed by work item id, returned by listWorkItemComments. */
	comments?: Record<string, Array<Record<string, unknown>>>;
	/** When true, creating a child work item (body has `parent`) throws — for testing follow-up-failure recovery. */
	failChildCreates?: boolean;
}

export interface FakeClient {
	client: PlaneClient;
	calls: RecordedCall[];
	createdLabels: Array<{ projectId: string; name: string }>;
	createdItems: Array<{ projectId: string; body: Record<string, unknown> }>;
	updatedItems: Array<{ projectId: string; workItemId: string; body: Record<string, unknown> }>;
	deletedItems: Array<{ projectId: string; workItemId: string }>;
	createdComments: Array<{ workItemId: string; body: Record<string, unknown> }>;
}

/**
 * Build a fake PlaneClient backed by in-memory data, recording calls so tests
 * can assert on request bodies and lookups without hitting the network.
 */
export function makeFakeClient(data: FakeData = {}): FakeClient {
	const calls: RecordedCall[] = [];
	const createdLabels: FakeClient["createdLabels"] = [];
	const createdItems: FakeClient["createdItems"] = [];
	const updatedItems: FakeClient["updatedItems"] = [];
	const deletedItems: FakeClient["deletedItems"] = [];
	const createdComments: FakeClient["createdComments"] = [];
	let sequence = 100;

	const record = (method: string, args: unknown[]) => calls.push({ method, args });

	const impl = {
		workItemWebUrl(projectId: string, workItemId: string): string {
			return `https://app.plane.so/ws/projects/${projectId}/issues/${workItemId}`;
		},

		projectBoardUrl(projectId: string): string {
			return `https://app.plane.so/ws/projects/${projectId}/issues/`;
		},

		async listProjects<T>(): Promise<T[]> {
			record("listProjects", []);
			return (data.projects ?? []) as unknown as T[];
		},

		async listStates<T>(projectId: string): Promise<T[]> {
			record("listStates", [projectId]);
			return (data.states?.[projectId] ?? []) as unknown as T[];
		},

		async listLabels<T>(projectId: string): Promise<T[]> {
			record("listLabels", [projectId]);
			return (data.labels?.[projectId] ?? []) as unknown as T[];
		},

		async createLabel<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
			record("createLabel", [projectId, body]);
			const name = String(body.name);
			createdLabels.push({ projectId, name });
			return { id: `label-${name.toLowerCase()}`, name } as unknown as T;
		},

		async listProjectMembers<T>(projectId: string): Promise<T[]> {
			record("listProjectMembers", [projectId]);
			return (data.members?.[projectId] ?? []) as unknown as T[];
		},

		async listWorkspaceMembers<T>(): Promise<T[]> {
			record("listWorkspaceMembers", []);
			return [] as unknown as T[];
		},

		async createWorkItem<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
			record("createWorkItem", [projectId, body]);
			// Mirror Plane's real 255-char title cap so tests catch over-long names.
			if (typeof body.name === "string" && body.name.length > 255) {
				throw new Error("400 Bad Request: Work item title cannot exceed 255 characters");
			}
			if (data.failChildCreates && body.parent !== undefined) {
				throw new Error("400 Bad Request: simulated child-create failure");
			}
			createdItems.push({ projectId, body });
			sequence += 1;
			return { id: `wi-${sequence}`, sequence_id: sequence } as unknown as T;
		},

		async updateWorkItem<T>(
			projectId: string,
			workItemId: string,
			body: Record<string, unknown>,
		): Promise<T> {
			record("updateWorkItem", [projectId, workItemId, body]);
			if (typeof body.name === "string" && body.name.length > 255) {
				throw new Error("400 Bad Request: Work item title cannot exceed 255 characters");
			}
			updatedItems.push({ projectId, workItemId, body });
			return { id: workItemId, sequence_id: 7 } as unknown as T;
		},

		async listWorkItems<T>(
			projectId: string,
			query: Record<string, string | number | boolean | undefined> = {},
		): Promise<T[]> {
			record("listWorkItems", [projectId, query]);
			let items = data.workItems?.[projectId] ?? [];
			if (query.external_id !== undefined) {
				items = items.filter((i) => i.external_id === query.external_id);
			}
			return items as unknown as T[];
		},

		// Mirrors Plane's single-object lookup: returns the matching work item or null.
		async findWorkItemByExternalId<T>(
			projectId: string,
			externalId: string,
			externalSource: string,
		): Promise<T | null> {
			record("findWorkItemByExternalId", [projectId, externalId, externalSource]);
			const items = data.workItems?.[projectId] ?? [];
			const match = items.find((i) => i.external_id === externalId);
			return (match ?? null) as T | null;
		},

		async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
			record("deleteWorkItem", [projectId, workItemId]);
			deletedItems.push({ projectId, workItemId });
		},

		async listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]> {
			record("listWorkItemComments", [projectId, workItemId]);
			return (data.comments?.[workItemId] ?? []) as unknown as T[];
		},

		async createWorkItemComment<T>(
			projectId: string,
			workItemId: string,
			body: Record<string, unknown>,
		): Promise<T> {
			record("createWorkItemComment", [projectId, workItemId, body]);
			createdComments.push({ workItemId, body });
			// Persist so a subsequent listWorkItemComments sees it (idempotency).
			if (!data.comments) data.comments = {};
			const list = data.comments[workItemId] ?? [];
			list.push(body);
			data.comments[workItemId] = list;
			return { id: `comment-${list.length}` } as unknown as T;
		},

		async getWorkItem<T>(projectId: string, workItemId: string): Promise<T> {
			record("getWorkItem", [projectId, workItemId]);
			const items = data.workItems?.[projectId] ?? [];
			const found = items.find((i) => i.id === workItemId);
			return (found ?? { id: workItemId, labels: [] }) as unknown as T;
		},
	};

	return {
		client: impl as unknown as PlaneClient,
		calls,
		createdLabels,
		createdItems,
		updatedItems,
		deletedItems,
		createdComments,
	};
}
