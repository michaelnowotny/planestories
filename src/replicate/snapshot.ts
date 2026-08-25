import { ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "../plane/client.ts";
import { normalizeRelationRef } from "../plane/relation_refs.ts";
import { sweepFetch } from "../utils/sweep.ts";
import {
	type ProjectSnapshot,
	RELATION_KINDS,
	type SequenceMap,
	SNAPSHOT_SCHEMA_VERSION,
	type SnapshotActivity,
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
	listWorkItemActivities<T>(projectId: string, workItemId: string): Promise<T[]>;
}

export interface TakeSnapshotOptions {
	toolVersion: string;
	/** Concurrency for the paced relation/comment sweeps (default 4). */
	concurrency?: number;
	/** Injectable clock (ISO string) for tests. */
	now?: () => string;
	onProgress?: (message: string) => void;
	/**
	 * Also capture each item's activity trail (one extra request per item, so it
	 * roughly doubles an already-expensive read). OPT-IN by design: this is for
	 * archiving a source instance you are about to retire, and the nightly
	 * backup must never inherit the cost silently.
	 */
	withActivity?: boolean;
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

interface RawActivity extends Record<string, unknown> {
	id: string;
	verb?: string | null;
	field?: string | null;
	old_value?: string | null;
	new_value?: string | null;
	old_identifier?: string | null;
	new_identifier?: string | null;
	actor?: string | null;
	created_at?: string | null;
	comment?: string | null;
	issue_comment?: string | null;
}

/** Raw activity keys `normalizeActivity` maps onto named fields; the rest go to `extras`. */
const KNOWN_ACTIVITY_KEYS = new Set([
	"id",
	"verb",
	"field",
	"old_value",
	"new_value",
	"old_identifier",
	"new_identifier",
	"actor",
	"created_at",
	"comment",
	"issue_comment",
]);

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

	// Activity capture is a third full sweep, so it stays behind the flag. Like
	// relations and comments it is FAIL-HARD, and here that is what makes the
	// data honest: only a sweep that succeeded for EVERY item lets an omitted
	// entry mean "this item has no history" rather than "we could not read it".
	// Take that away and the section becomes a set of empty arrays that cannot
	// be distinguished from real silence — the exact ambiguity that makes an
	// archive worthless as evidence.
	let activities: Record<string, SnapshotActivity[]> | undefined;
	if (options.withActivity) {
		progress(`Fetching activity for ${items.length} items (paced)...`);
		const activityStartedAt = Date.now();
		const activitySweep = await sweepFetch(
			items,
			(item) => client.listWorkItemActivities<RawActivity>(project.id, item.id),
			concurrency,
			paced("activity", activityStartedAt),
		);
		if (activitySweep.failures.length > 0) {
			throw new ReplicateError(
				`Snapshot incomplete: activity fetch failed for ${activitySweep.failures.length} item(s) ` +
					`after the paced sweep (first: ${describeError(activitySweep.failures[0]?.error)}). ` +
					"A partial snapshot is never written — re-run at a quieter hour.",
			);
		}
		activities = {};
		for (const { item, value } of activitySweep.results) {
			if (value.length === 0) {
				continue;
			}
			activities[item.id] = value
				.map(normalizeActivity)
				.sort(
					(a, b) =>
						(a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
				);
		}

		// The one failure this feature cannot afford: a sweep that "succeeds" for
		// every item while parsing nothing, producing a file that LOOKS like a
		// complete archive and is empty.
		//
		// `listAll` now REFUSES an envelope it does not recognize rather than
		// returning `[]`, so the original motivation — an unseen response shape
		// degrading to silence — is gone. This backstop stays anyway: it catches a
		// well-formed but genuinely empty sweep, and this runs ONCE, before a
		// source instance is retired.
		//
		// Board-wide zero is the tell. A single item with no activity is ordinary;
		// a whole project of items that have never been created, edited or moved is
		// not a board, it is a parse failure. Per-item zero stays legal precisely
		// because only the aggregate is incredible.
		const totalEntries = Object.values(activities).reduce((sum, list) => sum + list.length, 0);
		if (items.length > 0 && totalEntries === 0) {
			throw new ReplicateError(
				`Snapshot incomplete: --with-activity read ${items.length} item(s) and found NO activity ` +
					"entries at all. A populated board always has some, so this almost certainly means the " +
					"activity endpoint returned a response shape this build does not parse (it degrades to " +
					"empty rather than erroring) — not that the board has no history. Refusing to write a " +
					"file that would look like a complete archive. Verify with: curl -H 'x-api-key: …' " +
					`'<base>/api/v1/workspaces/<slug>/projects/${project.id}/${
						client.dialect === "work-items" ? "work-items" : "issues"
					}/<item-id>/activities/'`,
			);
		}
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
			activityInventory: options.withActivity ? "captured" : "not-requested",
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
		...(activities === undefined ? {} : { activities }),
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

function normalizeActivity(raw: RawActivity): SnapshotActivity {
	if (typeof raw.id !== "string") {
		// An entry with no id cannot be ordered deterministically or deduped, and
		// an audit record we cannot identify is not one we should silently keep.
		throw new ReplicateError(`Malformed activity entry in source response (id=${String(raw.id)})`);
	}
	// Keep EVERY key. This dump is taken once, immediately before a source instance
	// is retired, so anything dropped here is gone permanently — including keys this
	// build has never seen. Named fields stay typed and queryable; everything else
	// is preserved verbatim rather than guessed at.
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!KNOWN_ACTIVITY_KEYS.has(key)) {
			extras[key] = value;
		}
	}
	return {
		id: raw.id,
		verb: raw.verb ?? null,
		field: raw.field ?? null,
		oldValue: raw.old_value ?? null,
		newValue: raw.new_value ?? null,
		oldIdentifier: raw.old_identifier ?? null,
		newIdentifier: raw.new_identifier ?? null,
		actor: raw.actor ?? null,
		createdAt: raw.created_at ?? null,
		comment: raw.comment ?? null,
		issueComment: raw.issue_comment ?? null,
		...(Object.keys(extras).length > 0 ? { extras } : {}),
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
		// Digest-bound when captured. When absent this key contributes NOTHING,
		// because canonicalJson drops undefined values — which is precisely why
		// every snapshot written before activity capture existed still validates
		// against its original digest.
		activities: snapshot.activities,
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
	// The activity discriminator and the activity section must agree. They are
	// two halves of one fact, and a file where they disagree is one where
	// "no history" and "no capture" have become indistinguishable again — so
	// reject it rather than let a reader guess which half to believe.
	const activityInventory = snapshot.source?.activityInventory;
	if (activityInventory === "captured" && snapshot.activities === undefined) {
		throw new ReplicateError(
			'Snapshot claims source.activityInventory = "captured" but carries no "activities" ' +
				"section — the file is inconsistent and its activity coverage cannot be trusted.",
		);
	}
	if (activityInventory !== "captured" && snapshot.activities !== undefined) {
		throw new ReplicateError(
			'Snapshot carries an "activities" section but source.activityInventory is ' +
				`${JSON.stringify(activityInventory ?? null)} — refusing to guess whether the ` +
				"section is complete.",
		);
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
