import chalk from "chalk";
import { loadConfig } from "../config/loader.ts";
import { ConfigError } from "../errors.ts";
import type { PlaneClient } from "../plane/client.ts";
import type { ResolvedConfig } from "../types.ts";
import { type BoardCache, defaultBoardCachePath, readBoardCache } from "./board_cache.ts";
import { CacheSource } from "./cache_source.ts";
import { type GraphSourceRuntime, resolveGraph } from "./graph_source.ts";

export interface OpenBoardOptions {
	config?: string;
	context?: string;
	project?: string;
	refresh?: boolean;
	staleOk?: boolean;
	json?: boolean;
	selectProjectHelp?: string;
}

export interface OpenedBoard {
	config: ResolvedConfig;
	/** The client commands should read. A cache source after a hit or a refresh. */
	client: PlaneClient;
	/** The live client when `--refresh` fetched. Its pacing summary is the one to print. */
	pacingClient?: PlaneClient;
	/** The cache the answer was read from, including the copy `--refresh` just wrote. */
	cache: BoardCache;
	/**
	 * True when this is a previously stored copy. False after `--refresh`: the
	 * data was just fetched, then re-read from the cache so the answer is the
	 * copy that was stored.
	 */
	recorded: boolean;
}

/** Stderr line for a cache hit. Absolute instant, never a relative age. */
export function cacheReadLine(fetchedAt: string): string {
	return `Read from board cache (fetched ${fetchedAt}) — NOT live. No API calls were made.`;
}

/** Stderr line after a live fetch that replaced the cache. */
export function cacheStoredLine(fetchedAt: string): string {
	return `Live board fetched at ${fetchedAt} and stored in the local cache.`;
}

/**
 * Answer packet, epic, and doctor from a board cache that has work-item records,
 * or refresh that cache and answer from the copy just written.
 *
 * A cache with only the atlas graph is refused. The graph drops narrative HTML
 * and dangling relation targets, so a packet or a doctor report built from it
 * would be missing facts and still look complete.
 */
export async function openBoardCacheOrLive(
	options: OpenBoardOptions,
	runtime: GraphSourceRuntime = {},
): Promise<OpenedBoard> {
	const config = await loadConfig({ configPath: options.config, context: options.context });
	const source = await resolveGraph(
		{
			config: options.config,
			context: options.context,
			project: options.project,
			boardCache: {
				refresh: options.refresh === true,
				staleOk: options.staleOk === true,
				readRequired: options.refresh !== true,
				writeRequired: options.refresh === true,
			},
			json: options.json === true,
			selectProjectHelp: options.selectProjectHelp,
		},
		runtime,
	);

	const cachePath = runtime.cachePath ?? defaultBoardCachePath();
	const cache = await readBoardCache(cachePath, { onInvalid: "refuse" });
	if (!cache?.records || !cache.relations) {
		const when = cache ? ` (fetched ${cache.fetchedAt})` : "";
		const project = cache?.project.selectedAs ?? options.project ?? "the selected project";
		throw new ConfigError(
			`The board cache for "${project}"${when} has no work-item records, so this command cannot answer from it. ` +
				"The dependency graph alone drops descriptions and dangling relations. " +
				`Run \`planestories board fetch --project ${JSON.stringify(project)}\` to capture them.`,
		);
	}

	const recorded = source.provenance.kind === "cache";
	const line = recorded ? cacheReadLine(cache.fetchedAt) : cacheStoredLine(cache.fetchedAt);
	console.error(chalk.dim(line));

	if (source.provenance.kind !== "cache" && source.provenance.kind !== "live") {
		throw new ConfigError("This command answers from the board cache or a live refresh.");
	}

	return {
		config,
		client: new CacheSource(cache) as unknown as PlaneClient,
		pacingClient: source.client,
		cache,
		recorded,
	};
}
