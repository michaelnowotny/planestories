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
	/**
	 * Whether the per-item activity trail was captured (`--with-activity`).
	 *
	 * This exists so absence is never ambiguous. Without it, a reader finding no
	 * activities for an item cannot tell "this item genuinely has no history"
	 * from "nobody asked for history" — the two have opposite meanings and the
	 * house null-ban forbids a representation that reads both ways. With it:
	 * "captured" means the `activities` section is authoritative and an item
	 * missing from it provably has none (the sweep is fail-hard, so a partial
	 * read never reaches disk); "not-requested" means the section carries no
	 * information at all.
	 *
	 * OPTIONAL for backward compatibility, and `undefined` may be read as
	 * "not-requested" for a stated reason rather than as a convenient default:
	 * every snapshot written before this field existed was taken by a build with
	 * no way to capture activity.
	 */
	activityInventory?: "captured" | "not-requested";
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

/**
 * One entry from a work item's activity trail — the audit record of who changed
 * what, when. Captured only under `--with-activity`; never replayed by `apply`
 * (Plane stamps its own activity as the replica is written, and forging an audit
 * trail would be worse than not having one). This is archival evidence, kept so
 * a source instance can be retired without destroying its history.
 */
export interface SnapshotActivity {
	id: string;
	/** Plane's action verb: "created", "updated", "deleted". */
	verb: string | null;
	/** The field that changed, when the entry describes a field change. */
	field: string | null;
	/**
	 * The DISPLAY value before/after the change — a state or label NAME, not an id.
	 * Names are reused over a board's life, so these alone cannot be joined back to
	 * an entity; that is what the `*Identifier` pair below is for.
	 */
	oldValue: string | null;
	newValue: string | null;
	/**
	 * The UUID before/after the change (state/label/user). THE durable join key:
	 * `oldValue` says "In Progress", this says WHICH "In Progress". Dropping it was
	 * the review's most valuable catch — on a dump that can never be re-taken,
	 * keeping only the display name is irreversible loss the moment a name is reused.
	 */
	oldIdentifier: string | null;
	newIdentifier: string | null;
	/** The acting user's UUID. */
	actor: string | null;
	createdAt: string | null;
	/** Plane's human-readable rendering of the change, when present. */
	comment: string | null;
	/** Joins a comment-related entry to the `comments` section we already store in full. */
	issueComment: string | null;
	/**
	 * Every OTHER key Plane returned, verbatim. This is deliberate belt-and-braces
	 * for a ONE-SHOT irreversible capture: a named field can only preserve what we
	 * knew to ask for, and the cost of guessing wrong is a permanently missing
	 * column. Omitted entirely when Plane returned nothing beyond the known fields,
	 * so it never appears as an empty object pretending to be data.
	 */
	extras?: Record<string, unknown>;
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
	/**
	 * Keyed by source item UUID, in items order; entries ascending by createdAt
	 * then id. PRESENT if and only if `source.activityInventory === "captured"`
	 * — `parseSnapshot` enforces that, so the pair cannot drift into the
	 * ambiguity the discriminator exists to prevent. An item absent from a
	 * captured section provably has no activity.
	 */
	activities?: Record<string, SnapshotActivity[]>;
	sequence: SequenceMap;
	/**
	 * sha256 (hex) over the canonical content sections (source, project, states,
	 * labels, members, items, relations, comments, activities, sequence) — NOT
	 * over takenAt/toolVersion, so identical content yields an identical digest.
	 * The apply journal binds to this.
	 *
	 * `activities` is digest-bound like every other section (archival evidence
	 * that is not tamper-evident is worth little), and an ABSENT section
	 * contributes nothing, because the canonical encoder drops undefined values.
	 * That is what lets every snapshot taken before activity capture existed
	 * keep its original digest and keep parsing.
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
