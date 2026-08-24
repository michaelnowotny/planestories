import { PlaneApiError } from "../../src/errors.ts";
import type {
	PlaneClient,
	PlaneDependencyRelationType,
	PlaneIssueRelations,
} from "../../src/plane/client.ts";
import { normalizeRelations } from "../../src/plane/relation_refs.ts";

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
	/** Simulate Plane CE, which 404s on the relation-removal endpoint. */
	relationRemovalUnsupported?: boolean;
	instance?: { edition?: string; current_version?: string };
	/** Authenticated API-key owner returned by getCurrentUser; null simulates no resolvable user. */
	currentUser?: Record<string, unknown> | null;
	pqlUnsupported?: boolean;
	countEndpointUnsupported?: boolean;
	projects?: FakeProject[];
	states?: Record<string, FakeNamed[]>;
	labels?: Record<string, FakeNamed[]>;
	members?: Record<string, Array<Record<string, unknown>>>;
	/** Work items keyed by project id, returned by listWorkItems. */
	workItems?: Record<string, Array<Record<string, unknown>>>;
	/** Existing comments keyed by work item id, returned by listWorkItemComments. */
	comments?: Record<string, Array<Record<string, unknown>>>;
	/** Existing activity entries keyed by work item id, returned by /** House rule: a new PlaneClient method belongs on the fake. Read-only OPTIONS probe. */
	/** Existing activity entries keyed by work item id, returned by probeRelationMethods(_projectId: string, _workItemId: string) {
	/** Existing activity entries keyed by work item id, returned by 	return Promise.resolve({
	/** Existing activity entries keyed by work item id, returned by 		collection: { status: 405, allow: ["GET", "POST"] },
	/** Existing activity entries keyed by work item id, returned by 		removal: [
	/** Existing activity entries keyed by work item id, returned by 			{ status: 404, allow: [] as string[] },
	/** Existing activity entries keyed by work item id, returned by 			{ status: 404, allow: [] as string[] },
	/** Existing activity entries keyed by work item id, returned by 		],
	/** Existing activity entries keyed by work item id, returned by 	});
	/** Existing activity entries keyed by work item id, returned by },
	/** Existing activity entries keyed by work item id, returned by listWorkItemActivities. */
	activities?: Record<string, Array<Record<string, unknown>>>;
	/** Plane relation UUID arrays keyed by work item id. */
	relations?: Record<string, Partial<PlaneIssueRelations>>;
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
	createdRelations: Array<{
		projectId: string;
		workItemId: string;
		relationType: PlaneDependencyRelationType;
		issues: string[];
	}>;
	removedRelations: Array<{
		projectId: string;
		workItemId: string;
		relationType: PlaneDependencyRelationType;
		relatedIssue: string;
	}>;
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
	const createdRelations: FakeClient["createdRelations"] = [];
	const removedRelations: FakeClient["removedRelations"] = [];
	let sequence = 100;

	const record = (method: string, args: unknown[]) => calls.push({ method, args });
	const addUnique = (values: string[], value: string): void => {
		if (!values.includes(value)) values.push(value);
	};
	const relationState = (workItemId: string): PlaneIssueRelations => {
		if (!data.relations) data.relations = {};
		const current = data.relations[workItemId] ?? {};
		const complete: PlaneIssueRelations = {
			blocking: [...new Set(current.blocking ?? [])],
			blocked_by: [...new Set(current.blocked_by ?? [])],
			relates_to: [...new Set(current.relates_to ?? [])],
			duplicate: [...new Set(current.duplicate ?? [])],
			start_before: [...new Set(current.start_before ?? [])],
			start_after: [...new Set(current.start_after ?? [])],
			finish_before: [...new Set(current.finish_before ?? [])],
			finish_after: [...new Set(current.finish_after ?? [])],
		};
		data.relations[workItemId] = complete;
		return complete;
	};

	// Plane always returns dependency and relates_to relations mirrored on the
	// opposite issue. Normalize partial test seeds to that same reachable state.
	for (const workItemId of Object.keys(data.relations ?? {})) {
		const source = relationState(workItemId);
		for (const blocked of source.blocking) {
			addUnique(relationState(blocked).blocked_by, workItemId);
		}
		for (const blocker of source.blocked_by) {
			addUnique(relationState(blocker).blocking, workItemId);
		}
		for (const related of source.relates_to) {
			addUnique(relationState(related).relates_to, workItemId);
		}
	}

	const impl = {
		baseUrl: "https://api.plane.so",
		workspaceSlug: "ws",
		dialect: "issues" as const,
		dialectConfigured: true,
		concurrency: (): number | undefined => undefined,
		pacingSummary: (): string | undefined => undefined,
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

		async getInstance<T>(): Promise<T> {
			record("getInstance", []);
			return {
				instance: data.instance ?? { edition: "PLANE_CLOUD", current_version: "test" },
			} as T;
		},

		async getCurrentUser<T>(): Promise<T> {
			record("getCurrentUser", []);
			const currentUser =
				data.currentUser === undefined ? { id: "fake-current-user" } : data.currentUser;
			return currentUser as T;
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
			const item: Record<string, unknown> = {
				id: `wi-${sequence}`,
				sequence_id: sequence,
				...body,
			};
			// Fidelity: resolve a `state: <stateId>` to the expanded {name,group} object
			// (as real Plane returns), so a later list/normalizeFetched sees the group —
			// same as updateWorkItem (an import-created completed child must read back
			// with its group, not an undefined "still open").
			if (typeof item.state === "string") {
				const resolved = data.states?.[projectId]?.find((s) => s.id === item.state);
				if (resolved) {
					item.state = { id: resolved.id, name: resolved.name, group: resolved.group };
				}
			}
			if (!data.workItems) data.workItems = {};
			const projectItems = data.workItems[projectId] ?? [];
			projectItems.push(item);
			data.workItems[projectId] = projectItems;
			return item as unknown as T;
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
			const existing = data.workItems?.[projectId]?.find((item) => item.id === workItemId);
			if (existing) {
				// Fidelity: Plane returns `state` as an EXPANDED object (name+group). A
				// PATCH sends `state: <stateId>`; resolve it back to the object so a later
				// list/normalizeFetched sees the new group (a raw id string would read back
				// as an undefined stateGroup — i.e. "still open").
				const patched = { ...body };
				if (typeof patched.state === "string") {
					const resolved = data.states?.[projectId]?.find((s) => s.id === patched.state);
					if (resolved) {
						patched.state = { id: resolved.id, name: resolved.name, group: resolved.group };
					}
				}
				Object.assign(existing, patched);
			}
			return {
				id: workItemId,
				sequence_id: (existing?.sequence_id as number | undefined) ?? 7,
			} as unknown as T;
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

		async sampleWorkItem<T>(projectId: string): Promise<T | null> {
			record("sampleWorkItem", [projectId]);
			return ((data.workItems?.[projectId] ?? [])[0] ?? null) as T | null;
		},

		async probePql(projectId: string): Promise<void> {
			record("probePql", [projectId]);
			if (data.pqlUnsupported) {
				throw new PlaneApiError(
					'Plane API GET failed (400 Bad Request): {"pql":"PQL is not supported","unsupported_parameters":["pql"]}',
					400,
				);
			}
		},

		async probeWorkspaceCount(): Promise<void> {
			record("probeWorkspaceCount", []);
			if (data.countEndpointUnsupported) {
				throw new PlaneApiError("Plane API GET failed (404 Not Found)", 404);
			}
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

		// Required by AGENTS.md: a new PlaneClient method must exist here too. This
		// fake is cast through `as unknown as PlaneClient`, so tsc stays silent about
		// the omission and the next real-flow test to call it would die at runtime.
		async listWorkItemActivities<T>(projectId: string, workItemId: string): Promise<T[]> {
			record("listWorkItemActivities", [projectId, workItemId]);
			return (data.activities?.[workItemId] ?? []) as unknown as T[];
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

		/**
		 * Returns relations through the REAL normalizer, so this fake honours the
		 * same post-normalization contract as `PlaneClient.getRelations`.
		 *
		 * That means a test MAY seed the CE `{project_id, issue_id}` shape and get
		 * bare ids back, exactly as production does. What it deliberately does NOT
		 * do is emit raw objects to consumers: this fake stands in for the CLIENT,
		 * not for the wire, and a consumer can no longer receive an un-normalized
		 * ref. Wire-shape variance is covered where it actually lives — at the HTTP
		 * boundary, in tests/unit/plane/relation-refs.test.ts.
		 */
		async getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations> {
			record("getRelations", [projectId, workItemId]);
			return normalizeRelations(relationState(workItemId));
		},

		async createRelation(
			projectId: string,
			workItemId: string,
			relationType: PlaneDependencyRelationType,
			issues: string[],
		): Promise<void> {
			record("createRelation", [projectId, workItemId, relationType, issues]);
			createdRelations.push({ projectId, workItemId, relationType, issues: [...issues] });
			for (const related of issues) {
				const source = relationState(workItemId);
				const target = relationState(related);
				if (relationType === "blocked_by") {
					addUnique(source.blocked_by, related);
					addUnique(target.blocking, workItemId);
				} else if (relationType === "blocking") {
					addUnique(source.blocking, related);
					addUnique(target.blocked_by, workItemId);
				} else {
					addUnique(source.relates_to, related);
					addUnique(target.relates_to, workItemId);
				}
			}
		},

		async removeRelation(
			projectId: string,
			workItemId: string,
			relationType: PlaneDependencyRelationType,
			relatedIssue: string,
		): Promise<void> {
			record("removeRelation", [projectId, workItemId, relationType, relatedIssue]);
			// Plane CE exposes relation create and list but NOT remove: the
			// `/relations/remove/` endpoint 404s (verified on 1.4.1). `data.relationRemovalUnsupported`
			// reproduces that so the reconciler's degradation can be tested.
			if (data.relationRemovalUnsupported) {
				throw new PlaneApiError(
					"Plane API POST .../relations/remove/ failed (404 Not Found):",
					404,
				);
			}
			removedRelations.push({ projectId, workItemId, relationType, relatedIssue });
			const source = relationState(workItemId);
			const target = relationState(relatedIssue);
			const remove = (values: string[], value: string): void => {
				const index = values.indexOf(value);
				if (index !== -1) values.splice(index, 1);
			};
			if (relationType === "blocked_by") {
				remove(source.blocked_by, relatedIssue);
				remove(target.blocking, workItemId);
			} else if (relationType === "blocking") {
				remove(source.blocking, relatedIssue);
				remove(target.blocked_by, workItemId);
			} else {
				remove(source.relates_to, relatedIssue);
				remove(target.relates_to, workItemId);
			}
		},
	};

	return {
		client: Object.assign(impl, { maxRetries: 3 }) as unknown as PlaneClient,
		calls,
		createdLabels,
		createdItems,
		updatedItems,
		deletedItems,
		createdComments,
		createdRelations,
		removedRelations,
	};
}
