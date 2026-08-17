import { ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "../plane/client.ts";
import { sweepFetch } from "../utils/sweep.ts";
import {
	type ProjectSnapshot,
	RELATION_KINDS,
	type SequenceMap,
	SNAPSHOT_SCHEMA_VERSION,
	type SnapshotComment,
	type SnapshotItem,
	type SnapshotLabel,
	type SnapshotMember,
	type SnapshotRelations,
	type SnapshotState,
} from "./types.ts";

/** The read surface `takeSnapshot` needs (narrow, so tests can fake it). */
export interface SnapshotClient {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	readonly dialect: PlaneEndpointDialect;
	concurrency?(): number | undefined;
	getProject<T>(projectId: string): Promise<T>;
	listProjects<T>(): Promise<T[]>;
	listStates<T>(projectId: string): Promise<T[]>;
	listLabels<T>(projectId: string): Promise<T[]>;
	listProjectMembers<T>(projectId: string): Promise<T[]>;
	listWorkspaceMembers<T>(): Promise<T[]>;
	listWorkItems<T>(
		projectId: string,
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]>;
}

export interface TakeSnapshotOptions {
	toolVersion: string;
	/** Concurrency for the paced relation/comment sweeps (default 4). */
	concurrency?: number;
	/** Injectable clock (ISO string) for tests. */
	now?: () => string;
	onProgress?: (message: string) => void;
}

interface RawProject {
	id: string;
	name?: string;
	identifier?: string;
	description?: string;
}

interface RawState {
	id: string;
	name?: string;
	group?: string;
	color?: string;
	description?: string;
	default?: boolean;
}

interface RawLabel {
	id: string;
	name?: string;
	color?: string;
	description?: string;
	parent?: string | null;
}

interface RawMember {
	id?: string;
	member?: string;
	email?: string;
	display_name?: string;
}

interface RawItem {
	id: string;
	sequence_id: number;
	name?: string;
	description_html?: string | null;
	priority?: string | null;
	point?: number | null;
	state?: string | null;
	parent?: string | null;
	labels?: string[];
	assignees?: string[];
	created_at?: string | null;
	updated_at?: string | null;
	created_by?: string | null;
	start_date?: string | null;
	target_date?: string | null;
	completed_at?: string | null;
	external_source?: string | null;
	external_id?: string | null;
}

interface RawComment {
	id: string;
	comment_html?: string;
	created_at?: string | null;
	created_by?: string | null;
	actor?: string | null;
}

/**
 * Read one Plane project COMPLETELY into a self-contained snapshot — the one
 * expensive paced read. Fail-hard on ANY partial read: a snapshot that silently
 * misses relations or comments would replicate as silent data loss.
 */
export async function takeSnapshot(
	client: SnapshotClient,
	projectRef: { projectId?: string; projectName?: string },
	options: TakeSnapshotOptions,
): Promise<ProjectSnapshot> {
	const progress = options.onProgress ?? (() => {});
	// A 2,550-item board took 85 minutes on a real link while the runbook said "~25
	// min" — and that uncertainty got two runs killed mid-flight. Report throughput
	// and a running estimate so "slow" is legible instead of alarming.
	const paced = (label: string, startedAt: number) => (doneCount: number, total: number) => {
		if (doneCount !== total && doneCount % 100 !== 0) return;
		const elapsedMs = Date.now() - startedAt;
		const perItem = elapsedMs / Math.max(1, doneCount);
		const remaining = Math.max(0, total - doneCount) * perItem;
		const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60000))}m`;
		progress(
			doneCount === total
				? `  ${label}: ${total}/${total} done in ${mins(elapsedMs)}`
				: `  ${label}: ${doneCount}/${total} (~${mins(remaining)} left)`,
		);
	};

	const project = await resolveProject(client, projectRef);
	progress(`Snapshotting project ${project.identifier ?? project.id} (${project.name ?? "?"})`);

	const [rawStates, rawLabels, projectMembers, workspaceMembers] = [
		await client.listStates<RawState>(project.id),
		await client.listLabels<RawLabel>(project.id),
		await client.listProjectMembers<RawMember>(project.id),
		await client.listWorkspaceMembers<RawMember>(),
	];

	progress("Listing work items...");
	const liveRaw = await client.listWorkItems<RawItem>(project.id);
	const archivedRaw = await client.listArchivedWorkItems<RawItem>(project.id);
	const archivedInventory = archivedRaw === null ? "unavailable" : "listed";
	if (archivedRaw === null) {
		progress("Archived-items endpoint unavailable on this instance; gaps will need the gate.");
	}

	const items = [
		...liveRaw.map((raw) => normalizeItem(raw, false)),
		...(archivedRaw ?? []).map((raw) => normalizeItem(raw, true)),
	].sort((a, b) => a.sequenceId - b.sequenceId);

	const sequence = buildSequenceMap(items);

	// Derive concurrency HERE, not at entry: the list phase above has now fed the
	// latency EWMA, so Little's Law sees a real L instead of the seed value.
	const concurrency = options.concurrency ?? client.concurrency?.() ?? 4;
	progress(`Fetching relations for ${items.length} items (paced)...`);
	const relationsStartedAt = Date.now();
	const relationsSweep = await sweepFetch(
		items,
		(item) => client.getRelations(project.id, item.id),
		concurrency,
		paced("relations", relationsStartedAt),
	);
	if (relationsSweep.failures.length > 0) {
		throw new ReplicateError(
			`Snapshot incomplete: relation fetch failed for ${relationsSweep.failures.length} item(s) ` +
				`after the paced sweep (first: ${describeError(relationsSweep.failures[0]?.error)}). ` +
				"A partial snapshot is never written — re-run at a quieter hour.",
		);
	}

	progress(`Fetching comments for ${items.length} items (paced)...`);
	const commentsStartedAt = Date.now();
	const commentsSweep = await sweepFetch(
		items,
		(item) => client.listWorkItemComments<RawComment>(project.id, item.id),
		concurrency,
		paced("comments", commentsStartedAt),
	);
	if (commentsSweep.failures.length > 0) {
		throw new ReplicateError(
			`Snapshot incomplete: comment fetch failed for ${commentsSweep.failures.length} item(s) ` +
				`after the paced sweep (first: ${describeError(commentsSweep.failures[0]?.error)}). ` +
				"A partial snapshot is never written — re-run at a quieter hour.",
		);
	}

	const relations: Record<string, SnapshotRelations> = {};
	for (const { item, value } of relationsSweep.results) {
		const compact = compactRelations(value);
		if (compact) {
			relations[item.id] = compact;
		}
	}

	const comments: Record<string, SnapshotComment[]> = {};
	for (const { item, value } of commentsSweep.results) {
		if (value.length === 0) {
			continue;
		}
		comments[item.id] = value
			.map(normalizeComment)
			.sort(
				(a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
			);
	}

	const snapshot: ProjectSnapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		toolVersion: options.toolVersion,
		takenAt: (options.now ?? (() => new Date().toISOString()))(),
		source: {
			baseUrl: client.baseUrl,
			workspaceSlug: client.workspaceSlug,
			projectId: project.id,
			dialect: client.dialect,
			archivedInventory,
		},
		project: {
			name: project.name ?? "",
			identifier: project.identifier ?? "",
			description: project.description ?? "",
		},
		states: rawStates
			.map(normalizeState)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
		labels: rawLabels
			.map(normalizeLabel)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
		members: mergeMembers(projectMembers, workspaceMembers),
		items,
		relations,
		comments,
		sequence,
		digest: "",
	};
	snapshot.digest = computeSnapshotDigest(snapshot);
	return snapshot;
}

async function resolveProject(
	client: SnapshotClient,
	ref: { projectId?: string; projectName?: string },
): Promise<RawProject> {
	if (ref.projectId) {
		return client.getProject<RawProject>(ref.projectId);
	}
	if (!ref.projectName) {
		throw new ReplicateError("takeSnapshot needs a projectId or projectName");
	}
	const projects = await client.listProjects<RawProject>();
	const match = projects.find(
		(p) => p.name === ref.projectName || p.identifier === ref.projectName,
	);
	if (!match) {
		throw new ReplicateError(
			`Project "${ref.projectName}" not found in workspace ${client.workspaceSlug}. ` +
				`Available: ${projects.map((p) => p.name).join(", ")}`,
		);
	}
	// Re-fetch by id so the snapshot carries the full project payload.
	return client.getProject<RawProject>(match.id);
}

function normalizeItem(raw: RawItem, archived: boolean): SnapshotItem {
	if (typeof raw.id !== "string" || typeof raw.sequence_id !== "number") {
		throw new ReplicateError(
			`Malformed work item in source response (id=${String(raw.id)} sequence_id=${String(raw.sequence_id)})`,
		);
	}
	return {
		id: raw.id,
		sequenceId: raw.sequence_id,
		name: raw.name ?? "",
		descriptionHtml: raw.description_html ?? null,
		priority: raw.priority ?? null,
		point: typeof raw.point === "number" ? raw.point : null,
		stateId: raw.state ?? null,
		parentId: raw.parent ?? null,
		labelIds: [...(raw.labels ?? [])].sort(),
		assigneeIds: [...(raw.assignees ?? [])].sort(),
		createdAt: raw.created_at ?? null,
		updatedAt: raw.updated_at ?? null,
		createdBy: raw.created_by ?? null,
		startDate: raw.start_date ?? null,
		targetDate: raw.target_date ?? null,
		completedAt: raw.completed_at ?? null,
		externalSource: raw.external_source ?? null,
		externalId: raw.external_id ?? null,
		archived,
	};
}

function normalizeState(raw: RawState): SnapshotState {
	return {
		id: raw.id,
		name: raw.name ?? "",
		group: raw.group ?? "",
		color: raw.color ?? "",
		description: raw.description ?? "",
		isDefault: raw.default === true,
	};
}

function normalizeLabel(raw: RawLabel): SnapshotLabel {
	return {
		id: raw.id,
		name: raw.name ?? "",
		color: raw.color ?? "",
		description: raw.description ?? "",
		parentId: raw.parent ?? null,
	};
}

function normalizeComment(raw: RawComment): SnapshotComment {
	return {
		id: raw.id,
		commentHtml: raw.comment_html ?? "",
		createdAt: raw.created_at ?? null,
		createdBy: raw.created_by ?? raw.actor ?? null,
	};
}

/**
 * Merge project + workspace member lists (a comment author may no longer be a
 * project member). Plane member payloads vary: some carry the user id as `id`,
 * membership rows carry it as `member`.
 */
function mergeMembers(project: RawMember[], workspace: RawMember[]): SnapshotMember[] {
	const byId = new Map<string, SnapshotMember>();
	for (const raw of [...project, ...workspace]) {
		const id = raw.member ?? raw.id;
		if (!id || byId.has(id)) {
			continue;
		}
		byId.set(id, {
			id,
			email: raw.email ?? null,
			displayName: raw.display_name ?? null,
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildSequenceMap(items: SnapshotItem[]): SequenceMap {
	const present = items.map((i) => i.sequenceId);
	const seen = new Set<number>();
	for (const seq of present) {
		if (seen.has(seq)) {
			throw new ReplicateError(
				`Source project has two items with sequence number ${seq} — refusing to snapshot ` +
					"(this violates Plane's own uniqueness; investigate before replicating).",
			);
		}
		seen.add(seq);
	}
	const max = present.length > 0 ? Math.max(...present) : 0;
	const gaps: number[] = [];
	for (let n = 1; n <= max; n++) {
		if (!seen.has(n)) {
			gaps.push(n);
		}
	}
	return { max, present, gaps };
}

export function compactRelations(value: PlaneIssueRelations): SnapshotRelations | null {
	const compact: SnapshotRelations = {};
	let any = false;
	for (const kind of RELATION_KINDS) {
		const list = value[kind];
		if (Array.isArray(list) && list.length > 0) {
			const ids = list.map((ref) => {
				const id = normalizeRelationRef(ref);
				if (!id) {
					// Fail HARD: silently dropping an unrecognizable reference would
					// produce a digest-valid snapshot that is quietly missing edges.
					throw new ReplicateError(
						`Unrecognizable ${kind} relation reference in source response: ${JSON.stringify(ref)}`,
					);
				}
				return id;
			});
			compact[kind] = ids.sort();
			any = true;
		}
	}
	return any ? compact : null;
}

/**
 * A relation reference is a bare work-item UUID on the `/issues/` dialect but an
 * `{project_id, issue_id}` object on `/work-items/` (observed live on the
 * operator's CE, 2026-08-09). Normalize both to the item UUID.
 */
function normalizeRelationRef(ref: unknown): string | null {
	if (typeof ref === "string") return ref;
	if (ref !== null && typeof ref === "object") {
		const issueId = (ref as { issue_id?: unknown }).issue_id;
		if (typeof issueId === "string") return issueId;
	}
	return null;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Digest + file I/O
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively, arrays in order. Robust to
 * key re-ordering in a parsed file while remaining content-sensitive.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Content digest over the snapshot's data sections (not takenAt/toolVersion). */
export function computeSnapshotDigest(
	snapshot: Omit<ProjectSnapshot, "digest"> & { digest?: string },
): string {
	const content = {
		source: snapshot.source,
		project: snapshot.project,
		states: snapshot.states,
		labels: snapshot.labels,
		members: snapshot.members,
		items: snapshot.items,
		relations: snapshot.relations,
		comments: snapshot.comments,
		sequence: snapshot.sequence,
	};
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonicalJson(content));
	return hasher.digest("hex");
}

/** Serialize a snapshot for disk: pretty, stable, trailing newline. */
export function serializeSnapshot(snapshot: ProjectSnapshot): string {
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Parse + validate a snapshot file's content. The digest is RECOMPUTED and must
 * match: an edited or corrupted snapshot invalidates the exactness chain, so it
 * fails closed (re-snapshot instead of hand-editing).
 */
export function parseSnapshot(text: string): ProjectSnapshot {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ReplicateError("Snapshot file is not valid JSON");
	}
	if (raw === null || typeof raw !== "object") {
		throw new ReplicateError("Snapshot file is not a JSON object");
	}
	const snapshot = raw as ProjectSnapshot;
	if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new ReplicateError(
			`Snapshot schema version ${String(snapshot.schemaVersion)} is not supported ` +
				`(this build understands ${SNAPSHOT_SCHEMA_VERSION})`,
		);
	}
	for (const section of [
		"source",
		"project",
		"states",
		"labels",
		"members",
		"items",
		"relations",
		"comments",
		"sequence",
	] as const) {
		if (snapshot[section] === undefined || snapshot[section] === null) {
			throw new ReplicateError(`Snapshot file is missing its "${section}" section`);
		}
	}
	const expected = computeSnapshotDigest(snapshot);
	if (snapshot.digest !== expected) {
		throw new ReplicateError(
			"Snapshot digest mismatch — the file was edited or corrupted since it was taken. " +
				"Apply refuses edited snapshots (the exactness guarantees bind to the original " +
				"content); take a fresh snapshot instead.",
		);
	}
	// The serial writer walks items in ascending sequence; enforce the invariant
	// here so apply never has to re-sort (and a shuffled file fails loudly).
	for (let i = 1; i < snapshot.items.length; i++) {
		const prev = snapshot.items[i - 1];
		const curr = snapshot.items[i];
		if (prev && curr && prev.sequenceId >= curr.sequenceId) {
			throw new ReplicateError("Snapshot items are not strictly ascending by sequenceId");
		}
	}
	return snapshot;
}
