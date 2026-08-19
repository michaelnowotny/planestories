import type { PlaneEndpointDialect } from "./plane/client.ts";

/** Plane work item priority values. */
export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";

export const PLANE_PRIORITIES: readonly PlanePriority[] = [
	"urgent",
	"high",
	"medium",
	"low",
	"none",
] as const;

/** What a work item represents. `epic` detection is deferred (see plan decision #3). */
export type StoryKind = "story" | "criterion" | "epic";

export interface UserStory {
	/** Story title extracted from H2 heading */
	title: string;
	/** Plane work item UUID, null if not yet imported (used for updates) */
	planeId: string | null;
	/** Human-readable Plane identifier (e.g., "BLOOM-8"), null if not yet imported */
	planeIdentifier: string | null;
	/** Plane work item URL, null if not yet imported */
	planeUrl: string | null;
	/**
	 * Content hash of the last-synced payload, null if never synced. Used to skip
	 * re-importing a linked story whose content hasn't changed (P0-1). Written back
	 * as `plane_hash`.
	 */
	planeHash: string | null;
	/** Priority: urgent | high | medium | low | none (null = unset) */
	priority: PlanePriority | null;
	/** Label names to apply */
	labels: string[];
	/** Story point estimate */
	estimate: number | null;
	/**
	 * Developer-day effort (partial days allowed, e.g. 2.5). Distinct from
	 * `estimate` (integer story points → Plane `point`). Parsed from the
	 * `**Effort:** N dev-days` body line (its authoritative home, which round-trips
	 * through the Plane description) or materialized there from a YAML `effort_days:`
	 * input. Null when unset. Derived from the body — do not hash separately.
	 */
	effortDays: number | null;
	/** Assignee email or display name */
	assignee: string | null;
	/** State name (e.g., "Backlog", "Todo", "In Progress", "Done") */
	status: string | null;
	/** Full markdown body including description and acceptance criteria */
	body: string;
	/** Project name (from file frontmatter or per-story override) */
	project: string | null;
	/** Human identifier of the parent work item (e.g. "DATA-12"), or null. */
	parent: string | null;
	/** Human identifiers of work items that block this story. */
	blockedBy: string[];
	/** Human identifiers of work items this story blocks. */
	blocks: string[];
	/** Human identifiers of work items related to this story. */
	relatesTo: string[];
	/** Parser-level dependency validation findings retained after normalization. */
	relationValidationErrors?: string[];
	/** story | criterion | epic — informational on export; read on import. */
	kind: StoryKind | null;
	/** Optional evidence note posted once (idempotently) on create/update. */
	comment: string | null;
}

export interface FileFrontmatter {
	project?: string;
}

export interface ParsedFile {
	frontmatter: FileFrontmatter;
	stories: UserStory[];
	/** Original file path for write-back */
	filePath: string;
}

export interface CliConfig {
	apiKey?: string;
	workspaceSlug?: string;
	baseUrl?: string;
	dialect?: PlaneEndpointDialect;
	defaultProject?: string;
	defaultLabels?: string[];
	/** When set, tag every created work item with this label (auto-created). Off by default. */
	sourceLabel?: string;
	/** Plane API-key rate limit, in requests/minute or Plane's "60/minute" form. */
	apiRateLimit?: string | number;
	/** Safety ceiling for concurrency derived from the rate profile. */
	maxConcurrency?: number;
	/** Fraction of the configured rate available to this client. */
	rateHeadroom?: number;
}

export interface ContextEntry {
	name: string;
	apiKey?: string;
	workspaceSlug?: string;
	baseUrl?: string;
	dialect?: PlaneEndpointDialect;
	defaultProject?: string;
	defaultLabels?: string[];
	sourceLabel?: string;
	apiRateLimit?: string | number;
	maxConcurrency?: number;
	rateHeadroom?: number;
}

export interface MultiContextConfig {
	contexts: ContextEntry[];
	/**
	 * Which context applies when `--context` is omitted. Optional; must name an
	 * existing context — a dangling value is a startup error, never a silent
	 * fallback to some other installation.
	 */
	defaultContext?: string;
}

export interface ResolvedConfig {
	apiKey: string;
	workspaceSlug: string;
	baseUrl: string;
	/** Always resolved by loadConfig; optional here for legacy constructed test configs. */
	dialect?: PlaneEndpointDialect;
	defaultProject: string | null;
	defaultLabels: string[];
	/** Source label to tag created items with, or null when disabled. */
	sourceLabel: string | null;
	/** Retry budget for transient Plane API failures (429/5xx/network). From PLANE_MAX_RETRIES. */
	maxRetries: number;
	/**
	 * The context actually in force, however it was chosen — `--context`,
	 * `defaultContext`, or being the only one. Undefined on the bare-env default
	 * path. Reported to the user, because with implicit selection "which board did
	 * I just hit" is no longer answerable from the command line they typed.
	 */
	contextName?: string;
	/** Parsed requests per minute; undefined keeps pacing disabled for compatibility. */
	apiRateLimit?: number;
	maxConcurrency?: number;
	rateHeadroom?: number;
}

export interface ExportFilters {
	project?: string;
	issues?: string[];
	status?: string;
	/** State names to keep (repeatable --status); OR-combined with `status`. */
	statuses?: string[];
	/** Keep only open items (state group backlog/unstarted/started). */
	openOnly?: boolean;
	assignee?: string;
	/** Only export items stamped with this external_source (e.g. "planestories"). */
	externalSource?: string;
	/** Only export items carrying this label name. */
	label?: string;
}

/** A Plane work item normalized into a flat, name-resolved shape for serialization. */
export interface PlaneWorkItemData {
	id: string;
	identifier: string;
	url: string;
	title: string;
	description: string | undefined;
	priority: PlanePriority | undefined;
	estimate: number | undefined;
	state: { name: string } | undefined;
	assignee: { email?: string; displayName?: string } | undefined;
	labels: { nodes: Array<{ name: string }> };
	project: { name: string } | undefined;
}

export interface ImportResult {
	story: UserStory;
	action: "created" | "updated" | "failed" | "skipped" | "unchanged";
	planeId?: string;
	planeIdentifier?: string;
	planeUrl?: string;
	/** Content hash of the synced payload, written back as `plane_hash`. */
	planeHash?: string;
	/** Board URL of the project this story landed in (for a "view in Plane" hint). */
	projectUrl?: string;
	error?: string;
	/** In dry-run: "create" or "update" — what would happen for this story. */
	wouldAction?: "create" | "update";
	/** Free-form note, e.g. dry-run --check validation findings. */
	note?: string;
	/** Field-level dry-run explanation for a would-update result. */
	diff?: import("./sync/story-diff.ts").StoryDiff;
	/** Why a requested dry-run diff could not be computed. */
	diffUnavailable?: string;
	/**
	 * Dry-run detected a condition apply fails on before any PATCH (unknown
	 * parent). Excludes the story from the relation-reconciliation preview.
	 */
	applyWouldFail?: boolean;
}

export interface ImportSummary {
	total: number;
	created: number;
	updated: number;
	failed: number;
	skipped: number;
	/** Linked stories whose content hash matched — zero API writes made (P0-1). */
	unchanged: number;
	results: ImportResult[];
	/** Distinct label names created via --create-labels this run. */
	labelsCreated: string[];
	/** Distinct label names skipped (not found, not created) this run. */
	labelsSkipped: string[];
	/** Headings that look like design-doc sections, not stories (import --strict). */
	structureWarnings: string[];
	/** Dependency relations created during the reconciliation phase. */
	relationsCreated: number;
	/** Dependency relations removed during the reconciliation phase. */
	relationsRemoved: number;
	/** Dangling dependency references skipped during reconciliation. */
	relationWarnings: string[];
	/** Dependency validation/cycle errors. In dry-run these are reported, not thrown. */
	relationErrors: string[];
	/** Per-issue relation changes, or proposed changes in dry-run. */
	relationChanges: RelationChange[];
}

export interface RelationChange {
	identifier: string;
	created: string[];
	removed: string[];
}
