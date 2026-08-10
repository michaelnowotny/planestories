import { PlaneApiError } from "../../../src/errors.ts";
import type { PlaneEndpointDialect, PlaneRelationKind } from "../../../src/plane/client.ts";

export type CreateFailure = "ambiguous-committed" | "ambiguous-lost" | "permanent";

export interface FakeProject {
	id: string;
	name: string;
	identifier: string;
	description?: string;
	maxEver: number;
	items: Map<string, FakeItem>;
	states: Map<string, FakeState>;
	labels: Map<string, FakeLabel>;
	relations: Array<{ from: string; kind: string; to: string }>;
	comments: Map<string, FakeComment[]>;
}

export interface FakeItem extends Record<string, unknown> {
	id: string;
	sequence_id: number;
	name: string;
	archived_at: string | null;
}

interface FakeState extends Record<string, unknown> {
	id: string;
	name: string;
	group: string;
	color: string;
	description: string;
	default: boolean;
}

interface FakeLabel extends Record<string, unknown> {
	id: string;
	name: string;
	parent: string | null;
}

interface FakeComment extends Record<string, unknown> {
	id: string;
	comment_html: string;
}

const DEFAULT_STATES = [
	["Backlog", "backlog"],
	["Todo", "unstarted"],
	["In Progress", "started"],
	["Done", "completed"],
	["Cancelled", "cancelled"],
] as const;

/** Small behavioral fake: deletes never rewind maxEver. */
export class FakePlane {
	readonly baseUrl = "https://target.example.test";
	readonly workspaceSlug = "target";
	readonly dialect: PlaneEndpointDialect = "issues";
	readonly maxRetries = 2;
	readonly projects = new Map<string, FakeProject>();
	readonly members = [{ id: "target-user", email: "mapped@example.test", display_name: "Mapped" }];
	createCalls = 0;
	writeCalls = 0;
	failNextCreate: CreateFailure | null = null;
	failNextList = false;
	failNextPlaceholderDeleteCommitted = false;
	/** Throw this from the next getProject call (transient-failure injection). */
	failNextGetProject: PlaneApiError | null = null;
	/**
	 * When true, sequence numbers come from max(live)+1 instead of the max-ever
	 * ledger — the NON-Plane semantics the pre-write gate must fail closed on.
	 */
	sequenceReuse = false;
	acceptCreatedAt = true;
	acceptCreatedBy = true;
	rejectedRelationKinds = new Set<string>();
	archivedEndpointAvailable = true;
	archiveVerbAvailable = true;
	throwOnEveryWrite = false;
	/** Called immediately before the fake assigns the next sequence. */
	beforeCreate?: (projectId: string, body: Record<string, unknown>) => void;
	/** Remove this sequence just before the next list used by light verification. */
	vanishSequenceBeforeList: number | null = null;
	private serial = 0;

	private id(prefix: string): string {
		this.serial++;
		return `${prefix}-${this.serial}`;
	}

	private write(): void {
		this.writeCalls++;
		if (this.throwOnEveryWrite) throw new Error("write forbidden");
	}

	private project(id: string): FakeProject {
		const project = this.projects.get(id);
		if (!project) throw new PlaneApiError(`project ${id} not found`, 404);
		return project;
	}

	async listProjects<T>(): Promise<T[]> {
		return [...this.projects.values()].map(projectView) as T[];
	}

	async getProject<T>(projectId: string): Promise<T> {
		if (this.failNextGetProject) {
			const error = this.failNextGetProject;
			this.failNextGetProject = null;
			throw error;
		}
		return projectView(this.project(projectId)) as T;
	}

	async createProject<T>(body: Record<string, unknown>): Promise<T> {
		this.write();
		const identifier = String(body.identifier);
		if ([...this.projects.values()].some((project) => project.identifier === identifier)) {
			throw new PlaneApiError("identifier already exists", 409);
		}
		const id = this.id("project");
		const project: FakeProject = {
			id,
			name: String(body.name),
			identifier,
			description: body.description as string | undefined,
			maxEver: 0,
			items: new Map(),
			states: new Map(),
			labels: new Map(),
			relations: [],
			comments: new Map(),
		};
		for (const [index, [name, group]] of DEFAULT_STATES.entries()) {
			const state: FakeState = {
				id: this.id("state"),
				name,
				group,
				color: "#000000",
				description: "",
				default: index === 0,
			};
			project.states.set(state.id, state);
		}
		this.projects.set(id, project);
		return projectView(project) as T;
	}

	async deleteProject(projectId: string): Promise<void> {
		this.write();
		if (!this.projects.delete(projectId)) throw new PlaneApiError("not found", 404);
	}

	async listWorkspaceMembers<T>(): Promise<T[]> {
		return this.members as T[];
	}

	async createWorkItem<T>(
		projectId: string,
		body: Record<string, unknown>,
		_opts?: { maxRetries?: number },
	): Promise<T> {
		this.write();
		this.createCalls++;
		this.beforeCreate?.(projectId, body);
		const failure = this.failNextCreate;
		this.failNextCreate = null;
		if (failure === "ambiguous-lost") {
			throw new PlaneApiError("ambiguous network failure");
		}
		if (failure === "permanent") throw new PlaneApiError("bad request", 400);
		const project = this.project(projectId);
		const nextSequence = this.sequenceReuse
			? [...project.items.values()].reduce((max, item) => Math.max(max, item.sequence_id), 0) + 1
			: project.maxEver + 1;
		project.maxEver = Math.max(project.maxEver, nextSequence);
		const item: FakeItem = {
			...body,
			id: this.id("item"),
			sequence_id: nextSequence,
			name: String(body.name),
			created_at:
				this.acceptCreatedAt && typeof body.created_at === "string"
					? body.created_at
					: new Date().toISOString(),
			created_by:
				this.acceptCreatedBy && typeof body.created_by === "string" ? body.created_by : "system",
			archived_at: null,
		};
		project.items.set(item.id, item);
		if (failure === "ambiguous-committed") {
			throw new PlaneApiError("ambiguous network failure");
		}
		return { ...item } as T;
	}

	async listWorkItems<T>(projectId: string): Promise<T[]> {
		if (this.failNextList) {
			this.failNextList = false;
			throw new PlaneApiError("list failed", 503);
		}
		const project = this.project(projectId);
		if (this.vanishSequenceBeforeList !== null) {
			const victim = [...project.items.values()].find(
				(item) => item.sequence_id === this.vanishSequenceBeforeList,
			);
			if (victim) project.items.delete(victim.id);
			this.vanishSequenceBeforeList = null;
		}
		return [...project.items.values()]
			.filter((item) => item.archived_at === null)
			.map((item) => ({ ...item })) as T[];
	}

	async getWorkItem<T>(projectId: string, workItemId: string): Promise<T> {
		const item = this.project(projectId).items.get(workItemId);
		if (!item) throw new PlaneApiError("not found", 404);
		return { ...item } as T;
	}

	async updateWorkItem<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
	): Promise<T> {
		this.write();
		const item = this.project(projectId).items.get(workItemId);
		if (!item) throw new PlaneApiError("not found", 404);
		Object.assign(item, body);
		return { ...item } as T;
	}

	async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
		this.write();
		const project = this.project(projectId);
		const item = project.items.get(workItemId);
		if (!project.items.delete(workItemId)) {
			throw new PlaneApiError("not found", 404);
		}
		if (
			this.failNextPlaceholderDeleteCommitted &&
			item?.name.startsWith("planestories:placeholder:")
		) {
			this.failNextPlaceholderDeleteCommitted = false;
			throw new PlaneApiError("ambiguous delete committed");
		}
	}

	async archiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		this.write();
		if (!this.archiveVerbAvailable) throw new PlaneApiError("archive unavailable", 404);
		const item = this.project(projectId).items.get(workItemId);
		if (!item) throw new PlaneApiError("not found", 404);
		item.archived_at = new Date().toISOString();
	}

	async listArchivedWorkItems<T>(projectId: string): Promise<T[] | null> {
		if (!this.archivedEndpointAvailable) return null;
		return [...this.project(projectId).items.values()]
			.filter((item) => item.archived_at !== null)
			.map((item) => ({ ...item })) as T[];
	}

	async listStates<T>(projectId: string): Promise<T[]> {
		return [...this.project(projectId).states.values()].map((state) => ({ ...state })) as T[];
	}

	async createState<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		this.write();
		const state: FakeState = {
			id: this.id("state"),
			name: String(body.name),
			group: String(body.group),
			color: String(body.color),
			description: typeof body.description === "string" ? body.description : "",
			default: false,
		};
		this.project(projectId).states.set(state.id, state);
		return { ...state } as T;
	}

	async updateState<T>(
		projectId: string,
		stateId: string,
		body: Record<string, unknown>,
	): Promise<T> {
		this.write();
		const state = this.project(projectId).states.get(stateId);
		if (!state) throw new PlaneApiError("not found", 404);
		Object.assign(state, body);
		return { ...state } as T;
	}

	async listLabels<T>(projectId: string): Promise<T[]> {
		return [...this.project(projectId).labels.values()].map((label) => ({ ...label })) as T[];
	}

	async createLabel<T>(projectId: string, body: Record<string, unknown>): Promise<T> {
		this.write();
		const label: FakeLabel = {
			...body,
			id: this.id("label"),
			name: String(body.name),
			parent: null,
		};
		this.project(projectId).labels.set(label.id, label);
		return { ...label } as T;
	}

	async updateLabel<T>(
		projectId: string,
		labelId: string,
		body: Record<string, unknown>,
	): Promise<T> {
		this.write();
		const label = this.project(projectId).labels.get(labelId);
		if (!label) throw new PlaneApiError("not found", 404);
		Object.assign(label, body);
		return { ...label } as T;
	}

	async createRelation(
		projectId: string,
		workItemId: string,
		relationType: PlaneRelationKind,
		issues: string[],
	): Promise<void> {
		this.write();
		if (this.rejectedRelationKinds.has(relationType)) {
			throw new PlaneApiError(`relation ${relationType} rejected`, 400);
		}
		const project = this.project(projectId);
		for (const to of issues) {
			if (
				project.relations.some(
					(relation) =>
						relation.from === workItemId && relation.kind === relationType && relation.to === to,
				)
			) {
				throw new PlaneApiError("relation already exists", 409);
			}
			project.relations.push({ from: workItemId, kind: relationType, to });
		}
	}

	async createWorkItemComment<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
		_opts?: { maxRetries?: number },
	): Promise<T> {
		this.write();
		const comment: FakeComment = {
			...body,
			id: this.id("comment"),
			comment_html: String(body.comment_html),
			created_at:
				this.acceptCreatedAt && typeof body.created_at === "string"
					? body.created_at
					: new Date().toISOString(),
			created_by:
				this.acceptCreatedBy && typeof body.created_by === "string" ? body.created_by : "system",
		};
		const comments = this.project(projectId).comments.get(workItemId) ?? [];
		comments.push(comment);
		this.project(projectId).comments.set(workItemId, comments);
		return { ...comment } as T;
	}

	async listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]> {
		return (this.project(projectId).comments.get(workItemId) ?? []).map((comment) => ({
			...comment,
		})) as T[];
	}

	projectByIdentifier(identifier: string): FakeProject | undefined {
		return [...this.projects.values()].find((project) => project.identifier === identifier);
	}
}

function projectView(project: FakeProject) {
	return {
		id: project.id,
		name: project.name,
		identifier: project.identifier,
		description: project.description,
	};
}
