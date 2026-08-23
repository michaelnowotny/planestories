import chalk from "chalk";
import type { Command } from "commander";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { defaultBoardCachePath } from "../board_cache.ts";
import { type GraphSourceResult, type GraphSourceRuntime, resolveGraph } from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";

export interface BoardFetchOptions {
	config?: string;
	context?: string;
	project?: string;
}

/** Shared action seam so the real `board fetch` orchestration is no-network testable. */
export async function fetchBoardToCache(
	options: BoardFetchOptions,
	runtime: GraphSourceRuntime = {},
): Promise<GraphSourceResult> {
	return resolveGraph(
		{
			config: options.config,
			context: options.context,
			project: options.project,
			boardCache: { refresh: true, writeRequired: true },
		},
		runtime,
	);
}

function handleError(error: unknown): never {
	if (
		error instanceof ConfigError ||
		error instanceof ParseError ||
		error instanceof PlaneApiError ||
		error instanceof ResolverError
	) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else if (error instanceof Error) {
		console.error(chalk.red(`Error: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

export function registerBoardCommand(program: Command): void {
	const board = program
		.command("board")
		.description("Manage the local, identity-bound cache of a complete Plane board");

	board
		.command("fetch")
		.description("Fetch one complete board and atomically write .planestories/board.json")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project to cache (defaults to defaultProject)")
		.action(async (options) => {
			try {
				const source = await fetchBoardToCache({
					config: options.config,
					context: options.context,
					project: options.project,
				});
				// Publication already required complete coverage; keep the type-level
				// invariant explicit at the command boundary too.
				source.requireCompleteGraph("a reusable board cache");
				console.log(chalk.green(`Board cache written to ${defaultBoardCachePath()}`));
				if (source.client) reportPacing(source.client);
			} catch (error) {
				handleError(error);
			}
		});
}
