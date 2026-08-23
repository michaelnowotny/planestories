import chalk from "chalk";
import {
	type AtlasGraph,
	buildAtlasFromBoard,
	buildAtlasFromFile,
	type DependencyCoverage,
} from "../atlas/model.ts";
import { fetchRelationsWithSweep } from "../atlas/relations.ts";
import { loadConfig } from "../config/loader.ts";
import { ConfigError } from "../errors.ts";
import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import { fetchProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import { isCriterionChild } from "../sync/board-story.ts";
import { announceTarget } from "./announce_target.ts";
import {
	BOARD_CACHE_MAX_AGE_MS,
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	type BoardCacheWorkItem,
	boardCacheMatchesTarget,
	defaultBoardCachePath,
	formatBoardCacheAge,
	formatCachedBoardState,
	isBoardCacheStale,
	readBoardCache,
	writeBoardCacheAtomic,
} from "./board_cache.ts";
import {
	announceSnapshotSource,
	asClient,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "./snapshot_option.ts";
import { connectTarget } from "./target_client.ts";

export interface BoardCacheSourceOptions {
	/** Bypass a matching cache, fetch live, and replace the cache when complete. */
	refresh?: boolean;
	/** Explicitly acknowledge and use a matching cache older than the freshness limit. */
	staleOk?: boolean;
	/** A partial refresh is a command failure, never a published cache or success. */
	writeRequired?: boolean;
	/** Refuse instead of falling back to a live whole-board enumeration. */
	readRequired?: boolean;
}

export interface GraphSourceOptions {
	/** A markdown stories file — offline, no config, no API. */
	file?: string;
	config?: string;
	context?: string;
	project?: string;
	fromSnapshot?: string;
	/** Opt this command into the board cache as a third graph source. */
	boardCache?: BoardCacheSourceOptions;
	/** False skips the relation sweep (hierarchy only). */
	dependencies?: boolean;
	/** True keeps stdout machine-clean; provenance goes to stderr. */
	json?: boolean;
}

/** Injectable boundaries used by no-network source-selection tests. */
export interface GraphSourceRuntime {
	cachePath?: string;
	maxCacheAgeMs?: number;
	now?: () => Date;
	log?: (message: string) => void;
	warn?: (message: string) => void;
	connectTarget?: typeof connectTarget;
}

/** Durable provenance for a graph-backed answer, including recorded-source age. */
export type GraphSourceProvenance =
	| { kind: "file"; project: string; path: string }
	| { kind: "live"; project: string; baseUrl: string; workspaceSlug: string }
	| {
			kind: "snapshot";
			project: string;
			baseUrl: string;
			workspaceSlug: string;
			takenAt: string;
	  }
	| {
			kind: "cache";
			project: string;
			projectId: string;
			baseUrl: string;
			workspaceSlug: string;
			fetchedAt: string;
			itemCount: number;
	  };

/** One human provenance line shared by every graph-backed read command. */
export function formatGraphSourceProvenance(provenance: GraphSourceProvenance): string {
	if (provenance.kind === "snapshot") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · snapshot taken ${provenance.takenAt}`;
	}
	if (provenance.kind === "cache") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · cached at ${provenance.fetchedAt}`;
	}
	if (provenance.kind === "live") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · live`;
	}
	return `${provenance.project} · file ${provenance.path}`;
}

/** Thrown by `requireCompleteGraph`. Carries the coverage so callers can explain it. */
export class IncompleteGraphError extends Error {
	constructor(
		readonly coverage: DependencyCoverage,
		readonly purpose: string,
	) {
		super(
			coverage.kind === "skipped"
				? `Refusing to compute ${purpose}: dependency relations were not fetched, so the graph has no edges.`
				: `Refusing to compute ${purpose}: ${coverage.kind === "partial" ? coverage.failures : 0} relation lookup(s) failed, so the dependency graph is incomplete.`,
		);
		this.name = "IncompleteGraphError";
	}
}

/** A stale answer is a refusal, distinct from a network/configuration failure. */
export class StaleBoardCacheError extends Error {
	constructor(age: string) {
		super(
			`Cached board state is ${age} old — refusing to serve it as current. Pass --refresh to re-fetch, or --stale-ok to use it anyway.`,
		);
		this.name = "StaleBoardCacheError";
	}
}

/** A bounded local read cannot silently turn into the whole-board live sweep. */
export class RequiredBoardCacheError extends Error {
	constructor(project: string, reason: string, refreshCommand: string) {
		super(
			`A fresh, readable board cache for "${project}" is required (${reason}); refusing to fetch the whole board implicitly. ` +
				`Run: ${refreshCommand}`,
		);
		this.name = "RequiredBoardCacheError";
	}
}

/**
 * The graph, reachable ONLY through a method that names what the caller is doing
 * with it.
 *
 * There is deliberately no `graph` property. Three review rounds found the same
 * defect — a completeness rule honoured at one call site and forgotten at the
 * next — because the rule lived in a COMMENT and `const { graph } = await
 * resolveGraph(...)` compiled fine without it. `trend` and `diff` both did
 * exactly that. Now that line does not type-check, so the question has to be
 * answered rather than remembered.
 */
export interface GraphSourceResult {
	/** The client used, when one was — for `reportPacing`. Absent offline. */
	client?: PlaneClient;
	provenance: GraphSourceProvenance;
	coverage: DependencyCoverage;
	/** Lookups recovered by the sequential second pass (informational). */
	relationRecovered: number;
	/**
	 * For anything that computes a FIGURE from the dependency structure. A missing
	 * `blocks` edge silently shortens a schedule floor or hides a cycle that should
	 * have been a refusal, so this throws unless coverage is complete.
	 */
	requireCompleteGraph(purpose: string): AtlasGraph;
	/**
	 * For read-only views that can live with a dropped edge. The `reason` is not
	 * used at runtime — it exists so the choice is visible at the call site and in
	 * review, rather than being the silent default it used to be.
	 */
	acceptPartialGraph(reason: string): AtlasGraph;
	/**
	 * The cache's complete raw item inventory, including criterion children that
	 * are deliberately folded out of AtlasGraph. Available only on a cache hit.
	 */
	requireCachedWorkItems(purpose: string): readonly BoardCacheWorkItem[];
}

/**
 * Build an `AtlasGraph` from a stories file, a snapshot, a matching board cache,
 * or a live board — in that precedence order.
 *
 * This remains the one graph-construction path. The cache stores the output of
 * this same live builder; it does not introduce a parallel board interpretation.
 */
export async function resolveGraph(
	options: GraphSourceOptions,
	runtime: GraphSourceRuntime = {},
): Promise<GraphSourceResult> {
	if (options.file) {
		const content = await Bun.file(options.file).text();
		// A stories file carries its own `blocks:` lines, so the dependency
		// structure is fully present by construction — nothing was fetched, and
		// nothing was skipped either.
		const graph = buildAtlasFromFile(content, options.file);
		return graphSourceResult(graph, { kind: "complete" }, 0, {
			kind: "file",
			project: graph.project,
			path: options.file,
		});
	}

	if (options.boardCache?.refresh && options.boardCache.staleOk) {
		throw new ConfigError("--refresh and --stale-ok are mutually exclusive.");
	}
	if (options.boardCache?.refresh && options.boardCache.readRequired) {
		throw new ConfigError("A required cache read cannot also request a live refresh.");
	}
	if (options.boardCache?.refresh && options.dependencies === false) {
		throw new ConfigError(
			"--refresh cannot be combined with --no-dependencies: omit --no-dependencies to refresh the complete cache, or omit --refresh for a hierarchy-only view.",
		);
	}
	if (options.boardCache?.writeRequired && !options.boardCache.refresh) {
		throw new ConfigError("A required board-cache write must also request a refresh.");
	}

	let config = options.fromSnapshot
		? await loadConfigForSnapshot(options.config, options.context)
		: await loadConfig({ configPath: options.config, context: options.context });
	const snapshotSource = options.fromSnapshot
		? await openSnapshotSource(String(options.fromSnapshot))
		: null;
	if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);

	const projectName = options.project ?? snapshotSource?.projectName ?? config.defaultProject;
	if (!projectName) {
		throw new ConfigError(
			"Provide a <file> argument, or --project <name> (or a defaultProject) to read the live board.",
		);
	}

	// Cache lookup MUST precede connectTarget: even its cheap dialect probe is a
	// network call, which would make a supposedly local answer neither instant nor
	// offline. Explicit files/snapshots returned or selected above and never reach it.
	if (!snapshotSource && options.boardCache && !options.boardCache.refresh) {
		const cached = await readBoardCache(runtime.cachePath ?? defaultBoardCachePath(), {
			warn: cacheWarn(runtime),
			onInvalid: options.boardCache.readRequired ? "refuse" : "fetch-live",
		});
		if (
			cached &&
			boardCacheMatchesTarget(cached, {
				baseUrl: config.baseUrl,
				workspaceSlug: config.workspaceSlug,
				project: projectName,
			})
		) {
			const now = (runtime.now ?? (() => new Date()))();
			cacheLog(runtime)(formatCachedBoardState(cached, now));
			const age = formatBoardCacheAge(cached, now);
			if (isBoardCacheStale(cached, now, runtime.maxCacheAgeMs ?? BOARD_CACHE_MAX_AGE_MS)) {
				if (!options.boardCache.staleOk) {
					if (options.boardCache.readRequired) {
						throw new RequiredBoardCacheError(
							projectName,
							`the matching cache is ${age} old`,
							boardFetchCommand(options, projectName),
						);
					}
					throw new StaleBoardCacheError(age);
				}
				cacheWarn(runtime)(
					`⚠ Cached state is ${age} old — proceeding because --stale-ok was explicitly passed.`,
				);
			}

			const coverage: DependencyCoverage =
				options.dependencies === false ? { kind: "skipped" } : { kind: "complete" };
			return graphSourceResult(
				options.dependencies === false ? hierarchyOnly(cached.graph) : cached.graph,
				coverage,
				0,
				cacheProvenance(cached),
				undefined,
				cached.items,
			);
		}
		if (options.boardCache.readRequired) {
			throw new RequiredBoardCacheError(
				projectName,
				"no matching cache was found",
				boardFetchCommand(options, projectName),
			);
		}
	}

	let client = snapshotSource ? asClient(snapshotSource) : undefined;
	if (!client) {
		const target = await (runtime.connectTarget ?? connectTarget)(config, { project: projectName });
		config = target.config;
		client = target.client;
		// Read-only commands say it too: "which board am I looking at" is the first
		// question when a number surprises you.
		announceTarget(config, options.context, projectName);
	}

	const resolver = new Resolver(client);
	const project = await resolver.resolveProject(projectName);
	const index = await fetchProjectIndex(client, project.id, project.identifier);

	// Dependency edges need each non-criterion item's relations (one GET each).
	// A per-item failure DROPS that item's edges rather than aborting: for a
	// read-only view a graph with most edges beats no graph. Callers that cannot
	// tolerate a missing edge must say so via GraphSourceResult.
	let relationsById: Map<string, PlaneIssueRelations> | undefined;
	let relationFailures = 0;
	let relationRecovered = 0;
	if (options.dependencies !== false) {
		const items = index.items.filter((item) => !isCriterionChild(item));
		const result = await fetchRelationsWithSweep(client, project.id, items);
		relationsById = result.relationsById;
		relationFailures = result.failed;
		relationRecovered = result.recovered;
		if (result.recovered > 0) {
			console.error(
				chalk.dim(
					`  recovered ${result.recovered} rate-limited relation lookup${result.recovered === 1 ? "" : "s"} in a paced second pass.`,
				),
			);
		}
		if (result.failed > 0) {
			console.error(
				chalk.yellow(
					`  ${result.failed}/${items.length} relation lookups failed even after the paced retry pass — some dependency edges may be missing.`,
				),
			);
		}
	}

	const coverage: DependencyCoverage =
		options.dependencies === false
			? { kind: "skipped" }
			: relationFailures > 0
				? { kind: "partial", failures: relationFailures }
				: { kind: "complete" };
	const graph = buildAtlasFromBoard(
		client,
		project.id,
		project.identifier,
		project.name,
		index,
		relationsById,
	);

	if (!snapshotSource && options.boardCache?.refresh) {
		if (coverage.kind !== "complete") {
			const reason =
				coverage.kind === "skipped"
					? "dependency relations were skipped"
					: `${coverage.failures} relation lookup(s) failed`;
			const message = `Board cache was not written because ${reason}; the previous complete cache, if any, is unchanged.`;
			if (options.boardCache.writeRequired) throw new Error(message);
			cacheWarn(runtime)(`⚠ ${message}`);
		} else {
			const now = (runtime.now ?? (() => new Date()))();
			const cache: BoardCache = {
				schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
				fetchedAt: now.toISOString(),
				instance: { baseUrl: config.baseUrl, workspaceSlug: config.workspaceSlug },
				project: {
					id: project.id,
					identifier: project.identifier,
					name: project.name,
					selectedAs: projectName,
				},
				itemCount: index.items.length,
				items: index.items.map((item) => ({
					id: item.id,
					identifier: `${project.identifier}-${item.sequenceId}`,
					title: item.name,
					updatedAt: item.updatedAt,
				})),
				dependencyCoverage: { kind: "complete" },
				graph,
			};
			await writeBoardCacheAtomic(runtime.cachePath ?? defaultBoardCachePath(), cache);
			cacheLog(runtime)(
				`→ board cache refreshed · ${project.name} · ${index.items.length} ${index.items.length === 1 ? "item" : "items"}`,
			);
		}
	}

	const provenance: GraphSourceProvenance = snapshotSource
		? {
				kind: "snapshot",
				project: project.name,
				baseUrl: snapshotSource.baseUrl,
				workspaceSlug: snapshotSource.workspaceSlug,
				takenAt: snapshotSource.takenAt,
			}
		: {
				kind: "live",
				project: project.name,
				baseUrl: config.baseUrl,
				workspaceSlug: config.workspaceSlug,
			};

	return graphSourceResult(graph, coverage, relationRecovered, provenance, client);
}

function cacheProvenance(cache: BoardCache): GraphSourceProvenance {
	return {
		kind: "cache",
		project: cache.project.name,
		projectId: cache.project.id,
		baseUrl: cache.instance.baseUrl,
		workspaceSlug: cache.instance.workspaceSlug,
		fetchedAt: cache.fetchedAt,
		itemCount: cache.itemCount,
	};
}

/** Preserve `--no-dependencies`: cached edges must not leak into a hierarchy-only view. */
function hierarchyOnly(graph: AtlasGraph): AtlasGraph {
	return {
		...graph,
		edges: [],
		counts: { ...graph.counts, edges: 0 },
	};
}

function cacheLog(runtime: GraphSourceRuntime): (message: string) => void {
	return runtime.log ?? ((message) => console.error(chalk.dim(message)));
}

function cacheWarn(runtime: GraphSourceRuntime): (message: string) => void {
	return runtime.warn ?? ((message) => console.error(chalk.yellow(message)));
}

function graphSourceResult(
	graph: AtlasGraph,
	coverage: DependencyCoverage,
	relationRecovered: number,
	provenance: GraphSourceProvenance,
	client?: PlaneClient,
	cachedWorkItems?: readonly BoardCacheWorkItem[],
): GraphSourceResult {
	return {
		client,
		provenance,
		coverage,
		relationRecovered,
		requireCompleteGraph(purpose: string): AtlasGraph {
			if (coverage.kind !== "complete") throw new IncompleteGraphError(coverage, purpose);
			return graph;
		},
		acceptPartialGraph(_reason: string): AtlasGraph {
			return graph;
		},
		requireCachedWorkItems(purpose: string): readonly BoardCacheWorkItem[] {
			if (!cachedWorkItems) {
				throw new ConfigError(
					`Cannot use ${purpose}: this graph did not come from the local board cache.`,
				);
			}
			return cachedWorkItems;
		},
	};
}

function boardFetchCommand(options: GraphSourceOptions, projectName: string): string {
	const args = ["planestories", "board", "fetch"];
	if (options.config) args.push("--config", JSON.stringify(options.config));
	if (options.context) args.push("--context", JSON.stringify(options.context));
	args.push("--project", JSON.stringify(projectName));
	return args.join(" ");
}
