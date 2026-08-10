import type { PlaneEndpointDialect, PlaneRelationKind } from "../plane/client.ts";

/**
 * On-disk snapshot schema version. Bump on any breaking shape change; `apply`
 * refuses a snapshot whose version it does not understand.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** All relation kinds, in canonical order (used for deterministic serialization). */
export const RELATION_KINDS: readonly PlaneRelationKind[] = [
	"blocked_by",
	"blocking",
	"relates_to",
	"duplicate",
	"start_before",
	"start_after",
	"finish_before",
	"finish_after",
];

/** Where the snapshot was taken from. Never contains credentials. */
export interface SnapshotSource {
	baseUrl: string;
	workspaceSlug: string;
	projectId: string;
	/** The endpoint dialect the snapshot was read through. */
	dialect: PlaneEndpointDialect;
	/**
	 * Whether the archived-items endpoint served ("listed") or 404'd
	 * ("unavailable"). When unavailable, sequence gaps cannot be distinguished
	 * from archived items — the apply gate fails closed on gaps in that case.
	 */
	archivedInventory: "listed" | "unavailable";
}

/** The replicable slice of the source project's own settings. */
export interface SnapshotProject {
	name: string;
	identifier: string;
	description: string;
}

export interface SnapshotState {
	id: string;
	name: string;
	group: string;
	color: string;
	description: string;
	isDefault: boolean;
}

export interface SnapshotLabel {
	id: string;
	name: string;
	color: string;
	description: string;
	/** Parent label UUID (Plane supports label nesting), or null. */
	parentId: string | null;
}

export interface SnapshotMember {
	id: string;
	email: string | null;
	displayName: string | null;
}

export interface SnapshotItem {
	id: string;
	sequenceId: number;
	name: string;
	descriptionHtml: string | null;
	priority: string | null;
	/** Plane's `point` field (estimate). */
	point: number | null;
	stateId: string | null;
	parentId: string | null;
	labelIds: string[];
	assigneeIds: string[];
	createdAt: string | null;
	updatedAt: string | null;
	createdBy: string | null;
	startDate: string | null;
	targetDate: string | null;
	completedAt: string | null;
	externalSource: string | null;
	externalId: string | null;
	/** True when the item came from the archived inventory. */
	archived: boolean;
}

export interface SnapshotComment {
	id: string;
	commentHtml: string;
	createdAt: string | null;
	/** The authoring user's UUID (Plane's created_by / actor). */
	createdBy: string | null;
}

/** Per-item relation edges, by kind, as SOURCE work-item UUID lists. */
export type SnapshotRelations = Partial<Record<PlaneRelationKind, string[]>>;

export interface SequenceMap {
	/** Highest sequence number OBSERVABLE on the source (live + archived). */
	max: number;
	/** Every observed sequence number, ascending. */
	present: number[];
	/**
	 * Numbers in 1..max with no observable item — deletions (ledger-retained),
	 * or items invisible to the API (drafts; archived when the inventory is
	 * unavailable). The apply gate decides what these are allowed to mean.
	 */
	gaps: number[];
}

/**
 * A self-contained, versioned, diff-stable snapshot of one Plane project —
 * the intermediate artifact between `replicate snapshot` and `replicate apply`,
 * and a full-fidelity project backup in its own right. Contains all board
 * content; treat as data and keep out of shared repos by default.
 */
export interface ProjectSnapshot {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	toolVersion: string;
	takenAt: string;
	source: SnapshotSource;
	project: SnapshotProject;
	states: SnapshotState[];
	labels: SnapshotLabel[];
	members: SnapshotMember[];
	/** Ascending by sequenceId; includes archived items. */
	items: SnapshotItem[];
	/** Keyed by source item UUID, in items order. Only non-empty kinds present. */
	relations: Record<string, SnapshotRelations>;
	/** Keyed by source item UUID, in items order; comments ascending by createdAt then id. */
	comments: Record<string, SnapshotComment[]>;
	sequence: SequenceMap;
	/**
	 * sha256 (hex) over the canonical content sections (source, project, states,
	 * labels, members, items, relations, comments, sequence) — NOT over
	 * takenAt/toolVersion, so identical content yields an identical digest. The
	 * apply journal binds to this.
	 */
	digest: string;
}

// ---------------------------------------------------------------------------
// Apply-side shared types
// ---------------------------------------------------------------------------

/** How identifiers will be produced on the target. */
export type IdentifierMode = "exact" | "renumber";

export interface DegradationEntry {
	feature: string;
	detail: string;
	/** How many entities the degradation touches. */
	count: number;
}

export interface ApplyManifests {
	/** Feature → fallback degradations (restorable/explainable). */
	degradations: DegradationEntry[];
	/** Entities v1 does not carry, counted (the loss report). */
	losses: DegradationEntry[];
	warnings: string[];
}
