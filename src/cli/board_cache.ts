import { lstat, mkdir, rename as renameFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtlasGraph, AtlasNode, DependencyCoverage } from "../atlas/model.ts";
import { findRepoRoot } from "./output_path.ts";

export const BOARD_CACHE_SCHEMA_VERSION = 2 as const;
export const BOARD_CACHE_MAX_AGE_MS = 60 * 60 * 1_000;

export interface BoardCacheInstance {
	baseUrl: string;
	workspaceSlug: string;
}

export interface BoardCacheProject {
	id: string;
	identifier: string;
	name: string;
	/** Exact project selector supplied when this cache was fetched. */
	selectedAs: string;
}

/**
 * The minimal all-work-item inventory used to bound live per-item reads.
 *
 * This is deliberately separate from `AtlasGraph.nodes`: the graph folds legacy
 * criterion children into their parent, while an activity audit must retain the
 * UUID and timestamp of every Plane work item it might need to inspect.
 */
export interface BoardCacheWorkItem {
	id: string;
	identifier: string;
	title: string;
	updatedAt: string | null;
}

/**
 * A complete, derived board graph plus the identity and clock needed to decide
 * whether it is safe to answer from it. Credentials are deliberately absent.
 */
export interface BoardCache {
	schemaVersion: typeof BOARD_CACHE_SCHEMA_VERSION;
	fetchedAt: string;
	instance: BoardCacheInstance;
	project: BoardCacheProject;
	/** Raw Plane work-item count, before criterion children are folded into stories. */
	itemCount: number;
	/** Every raw work item, including legacy criterion children folded out of the graph. */
	items: BoardCacheWorkItem[];
	/** Cache publication is permitted only after a complete relation sweep. */
	dependencyCoverage: Extract<DependencyCoverage, { kind: "complete" }>;
	graph: AtlasGraph;
}

export interface BoardCacheTarget {
	baseUrl: string;
	workspaceSlug: string;
	/** Exact project selector supplied by the command. */
	project: string;
}

export interface ReadBoardCacheOptions {
	warn?: (message: string) => void;
	/** A cache-required caller refuses instead of promising the usual live fallback. */
	onInvalid?: "fetch-live" | "refuse";
}

export interface BoardCacheWriteRuntime {
	/** Injectable failure seam proving a failed publish cannot replace the old file. */
	rename?: (from: string, to: string) => Promise<void>;
}

/** Repository-root cache path, even when the command runs from a subdirectory. */
export function defaultBoardCachePath(from: string = process.cwd()): string {
	return join(findRepoRoot(from), ".planestories", "board.json");
}

/** Normalize without losing path/port: false negatives fetch live; false positives answer wrongly. */
export function normalizeBoardBaseUrl(value: string): string {
	const parsed = new URL(value);
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
		throw new Error(`invalid Plane base URL ${JSON.stringify(value)}`);
	}
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/+$/, "");
}

/** Host/workspace/project must ALL agree before cached data is eligible. */
export function boardCacheMatchesTarget(cache: BoardCache, target: BoardCacheTarget): boolean {
	let cacheUrl: string;
	let targetUrl: string;
	try {
		cacheUrl = normalizeBoardBaseUrl(cache.instance.baseUrl);
		targetUrl = normalizeBoardBaseUrl(target.baseUrl);
	} catch {
		return false;
	}
	if (cacheUrl !== targetUrl || cache.instance.workspaceSlug !== target.workspaceSlug) return false;

	// Project aliases are not interchangeable here. Plane resolves an exact name
	// before an identifier, so one project's name can collide with another
	// project's identifier. Only the exact selector that produced the cache is
	// safe to reuse; a false negative merely performs a fresh fetch.
	return target.project.length > 0 && cache.project.selectedAs === target.project;
}

export function boardCacheAgeMs(cache: BoardCache, now: Date = new Date()): number {
	return Math.max(0, now.getTime() - Date.parse(cache.fetchedAt));
}

export function isBoardCacheStale(
	cache: BoardCache,
	now: Date = new Date(),
	maxAgeMs: number = BOARD_CACHE_MAX_AGE_MS,
): boolean {
	return boardCacheAgeMs(cache, now) > maxAgeMs;
}

/** Compact human duration for the mandatory provenance line and stale refusal. */
export function formatBoardCacheAge(cache: BoardCache, now: Date = new Date()): string {
	const milliseconds = boardCacheAgeMs(cache, now);
	const minutes = Math.floor(milliseconds / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function formatCachedBoardState(cache: BoardCache, now: Date = new Date()): string {
	const items = `${cache.itemCount} ${cache.itemCount === 1 ? "item" : "items"}`;
	return `→ cached board state · ${cache.project.name} · ${items} · fetched ${formatBoardCacheAge(cache, now)} ago`;
}

/** Parse and validate deeply enough that corruption cannot become a crash or an empty answer. */
export function parseBoardCache(text: string): BoardCache {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	return validateBoardCache(parsed);
}

export function serializeBoardCache(cache: BoardCache): string {
	const validated = validateBoardCache(cache);
	return `${JSON.stringify(validated, null, "\t")}\n`;
}

/** Missing is quiet. Anything present-but-unusable warns; the caller chooses fallback or refusal. */
export async function readBoardCache(
	path: string,
	options: ReadBoardCacheOptions = {},
): Promise<BoardCache | null> {
	try {
		await lstat(path);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		warnUnreadable(path, error, options.warn, options.onInvalid);
		return null;
	}

	try {
		return parseBoardCache(await Bun.file(path).text());
	} catch (error) {
		warnUnreadable(path, error, options.warn, options.onInvalid);
		return null;
	}
}

/**
 * Publish in one rename from a fully-written sibling temp file. A failed fetch
 * never calls this; a failed write/rename leaves the previous cache untouched.
 */
export async function writeBoardCacheAtomic(
	path: string,
	cache: BoardCache,
	runtime: BoardCacheWriteRuntime = {},
): Promise<void> {
	const content = serializeBoardCache(cache);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await (runtime.rename ?? renameFile)(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

function warnUnreadable(
	path: string,
	error: unknown,
	warn: ((message: string) => void) | undefined,
	onInvalid: ReadBoardCacheOptions["onInvalid"] = "fetch-live",
): void {
	const next =
		onInvalid === "refuse"
			? "This command requires a refreshed matching cache."
			: "Fetching fresh board state.";
	const message =
		`⚠ Ignoring corrupt or unreadable board cache at ${path}: ` +
		`${error instanceof Error ? error.message : String(error)}. ${next}`;
	(warn ?? ((text) => console.warn(text)))(message);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function validateBoardCache(value: unknown): BoardCache {
	const cache = record(value, "cache root");
	if (cache.schemaVersion !== BOARD_CACHE_SCHEMA_VERSION) {
		throw new Error(
			`unsupported schemaVersion ${JSON.stringify(cache.schemaVersion)} (expected ${BOARD_CACHE_SCHEMA_VERSION})`,
		);
	}
	const fetchedAt = instant(cache.fetchedAt, "fetchedAt");
	const instance = record(cache.instance, "instance");
	const baseUrl = nonEmptyString(instance.baseUrl, "instance.baseUrl");
	normalizeBoardBaseUrl(baseUrl);
	const workspaceSlug = nonEmptyString(instance.workspaceSlug, "instance.workspaceSlug");
	const project = record(cache.project, "project");
	const projectValue: BoardCacheProject = {
		id: nonEmptyString(project.id, "project.id"),
		identifier: nonEmptyString(project.identifier, "project.identifier"),
		name: nonEmptyString(project.name, "project.name"),
		selectedAs: nonEmptyString(project.selectedAs, "project.selectedAs"),
	};
	const itemCount = nonNegativeInteger(cache.itemCount, "itemCount");
	if (!Array.isArray(cache.items)) throw new Error("items must be an array");
	const itemIds = new Set<string>();
	const itemIdentifiers = new Set<string>();
	const items = cache.items.map((value, index): BoardCacheWorkItem => {
		const path = `items[${index}]`;
		const item = record(value, path);
		const id = nonEmptyString(item.id, `${path}.id`);
		const identifier = nonEmptyString(item.identifier, `${path}.identifier`);
		if (itemIds.has(id)) throw new Error(`${path}.id duplicates work item ${id}`);
		if (itemIdentifiers.has(identifier)) {
			throw new Error(`${path}.identifier duplicates work item ${identifier}`);
		}
		itemIds.add(id);
		itemIdentifiers.add(identifier);
		return {
			id,
			identifier,
			title: nonEmptyString(item.title, `${path}.title`),
			updatedAt: nullableInstant(item.updatedAt, `${path}.updatedAt`),
		};
	});
	if (items.length !== itemCount) {
		throw new Error(`items length ${items.length} disagrees with itemCount ${itemCount}`);
	}
	const coverage = record(cache.dependencyCoverage, "dependencyCoverage");
	if (coverage.kind !== "complete") {
		throw new Error('dependencyCoverage must be { kind: "complete" }; partial caches are unsafe');
	}
	const graph = validateGraph(cache.graph, projectValue.name);

	return {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt,
		instance: { baseUrl, workspaceSlug },
		project: projectValue,
		itemCount,
		items,
		dependencyCoverage: { kind: "complete" },
		graph,
	};
}

function validateGraph(value: unknown, projectName: string): AtlasGraph {
	const graph = record(value, "graph");
	if (graph.source !== "board") throw new Error('graph.source must be "board"');
	if (graph.project !== projectName) {
		throw new Error("graph.project must match cache project.name");
	}
	const labels = stringArray(graph.labels, "graph.labels");
	const assignees = stringArray(graph.assignees, "graph.assignees");
	const statuses = stringArray(graph.statuses, "graph.statuses");
	if (!Array.isArray(graph.nodes)) throw new Error("graph.nodes must be an array");

	const ids = new Set<string>();
	const measured = { epics: 0, stories: 0, criteria: 0, flagged: 0 };
	const nodes = graph.nodes.map((node, index) =>
		validateNode(node, `graph.nodes[${index}]`, ids, measured),
	);
	if (!Array.isArray(graph.edges)) throw new Error("graph.edges must be an array");
	const edges = graph.edges.map((value, index) => {
		const edge = record(value, `graph.edges[${index}]`);
		const source = nonEmptyString(edge.source, `graph.edges[${index}].source`);
		const target = nonEmptyString(edge.target, `graph.edges[${index}].target`);
		if (edge.type !== "blocks" && edge.type !== "relates") {
			throw new Error(`graph.edges[${index}].type must be blocks or relates`);
		}
		if (!ids.has(source) || !ids.has(target)) {
			throw new Error(`graph.edges[${index}] references an unknown node`);
		}
		if (source === target) throw new Error(`graph.edges[${index}] is a self-edge`);
		return { source, target, type: edge.type as "blocks" | "relates" };
	});

	const counts = record(graph.counts, "graph.counts");
	const countValues = {
		epics: nonNegativeInteger(counts.epics, "graph.counts.epics"),
		stories: nonNegativeInteger(counts.stories, "graph.counts.stories"),
		criteria: nonNegativeInteger(counts.criteria, "graph.counts.criteria"),
		flagged: nonNegativeInteger(counts.flagged, "graph.counts.flagged"),
		edges: nonNegativeInteger(counts.edges, "graph.counts.edges"),
	};
	for (const key of ["epics", "stories", "criteria", "flagged"] as const) {
		if (countValues[key] !== measured[key]) {
			throw new Error(`graph.counts.${key} disagrees with graph.nodes`);
		}
	}
	if (countValues.edges !== edges.length) {
		throw new Error("graph.counts.edges disagrees with graph.edges");
	}

	return {
		project: projectName,
		source: "board",
		nodes,
		edges,
		labels,
		assignees,
		statuses,
		counts: countValues,
	};
}

function validateNode(
	value: unknown,
	path: string,
	ids: Set<string>,
	measured: { epics: number; stories: number; criteria: number; flagged: number },
): AtlasNode {
	const node = record(value, path);
	const id = nonEmptyString(node.id, `${path}.id`);
	if (ids.has(id)) throw new Error(`${path}.id duplicates node ${id}`);
	ids.add(id);
	if (node.kind !== "epic" && node.kind !== "story") {
		throw new Error(`${path}.kind must be epic or story`);
	}
	const statusGroups = new Set([
		"backlog",
		"unstarted",
		"started",
		"completed",
		"cancelled",
		"unknown",
	]);
	if (typeof node.statusGroup !== "string" || !statusGroups.has(node.statusGroup)) {
		throw new Error(`${path}.statusGroup is invalid`);
	}
	if (!Array.isArray(node.criteria)) throw new Error(`${path}.criteria must be an array`);
	const criteria = node.criteria.map((value, index) => {
		const criterion = record(value, `${path}.criteria[${index}]`);
		return {
			text: string(criterion.text, `${path}.criteria[${index}].text`),
			checked: boolean(criterion.checked, `${path}.criteria[${index}].checked`),
		};
	});
	if (!Array.isArray(node.children)) throw new Error(`${path}.children must be an array`);

	const quality = (() => {
		if (node.quality === null) return null;
		const qualityValue = record(node.quality, `${path}.quality`);
		return {
			ok: boolean(qualityValue.ok, `${path}.quality.ok`),
			flags: stringArray(qualityValue.flags, `${path}.quality.flags`),
		};
	})();
	if (node.kind === "epic") measured.epics += 1;
	else measured.stories += 1;
	measured.criteria += criteria.length;
	if (quality && !quality.ok) measured.flagged += 1;

	return {
		id,
		kind: node.kind,
		title: string(node.title, `${path}.title`),
		identifier: nullableString(node.identifier, `${path}.identifier`),
		url: nullableString(node.url, `${path}.url`),
		status: nullableString(node.status, `${path}.status`),
		statusGroup: node.statusGroup as AtlasNode["statusGroup"],
		labels: stringArray(node.labels, `${path}.labels`),
		assignee: nullableString(node.assignee, `${path}.assignee`),
		effortDays: nullableFiniteNumber(node.effortDays, `${path}.effortDays`),
		priority: nullableString(node.priority, `${path}.priority`),
		createdAt: nullableInstant(node.createdAt, `${path}.createdAt`),
		updatedAt: nullableInstant(node.updatedAt, `${path}.updatedAt`),
		criteria,
		quality,
		children: node.children.map((child, index) =>
			validateNode(child, `${path}.children[${index}]`, ids, measured),
		),
	};
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`${path} must be a string`);
	return value;
}

function nonEmptyString(value: unknown, path: string): string {
	const result = string(value, path);
	if (!result.trim()) throw new Error(`${path} must not be empty`);
	return result;
}

function nullableString(value: unknown, path: string): string | null {
	if (value === null) return null;
	return string(value, path);
}

function stringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((entry, index) => string(entry, `${path}[${index}]`));
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative integer`);
	}
	return value as number;
}

function nullableFiniteNumber(value: unknown, path: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${path} must be a non-negative finite number or null`);
	}
	return value;
}

function instant(value: unknown, path: string): string {
	const result = nonEmptyString(value, path);
	if (Number.isNaN(Date.parse(result))) throw new Error(`${path} must be an ISO-8601 instant`);
	return result;
}

function nullableInstant(value: unknown, path: string): string | null {
	if (value === null) return null;
	return instant(value, path);
}
