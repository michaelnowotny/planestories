/** Plane work item priority values. */
export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";

export const PLANE_PRIORITIES: readonly PlanePriority[] = [
	"urgent",
	"high",
	"medium",
	"low",
	"none",
] as const;

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
	/** Assignee email or display name */
	assignee: string | null;
	/** State name (e.g., "Backlog", "Todo", "In Progress", "Done") */
	status: string | null;
	/** Full markdown body including description and acceptance criteria */
	body: string;
	/** Project name (from file frontmatter or per-story override) */
	project: string | null;
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
	defaultProject?: string;
	defaultLabels?: string[];
	/** When set, tag every created work item with this label (auto-created). Off by default. */
	sourceLabel?: string;
}

export interface ContextEntry {
	name: string;
	apiKey?: string;
	workspaceSlug?: string;
	baseUrl?: string;
	defaultProject?: string;
	defaultLabels?: string[];
	sourceLabel?: string;
}

export interface MultiContextConfig {
	contexts: ContextEntry[];
}

export interface ResolvedConfig {
	apiKey: string;
	workspaceSlug: string;
	baseUrl: string;
	defaultProject: string | null;
	defaultLabels: string[];
	/** Source label to tag created items with, or null when disabled. */
	sourceLabel: string | null;
	/** Retry budget for transient Plane API failures (429/5xx/network). From PLANE_MAX_RETRIES. */
	maxRetries: number;
}

export interface ExportFilters {
	project?: string;
	issues?: string[];
	status?: string;
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
}
