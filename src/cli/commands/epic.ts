import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import type { PlaneClient } from "../../plane/client.ts";
import { rollupEpic } from "../../sync/rollup.ts";
import type { ResolvedConfig } from "../../types.ts";
import { openBoardCacheOrLive } from "../local_board.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import {
	announceSnapshotSource,
	asClient,
	FROM_SNAPSHOT_HELP,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "../snapshot_option.ts";

function handleError(error: unknown): never {
	if (
		error instanceof ParentCycleError ||
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

export function registerEpicCommand(program: Command) {
	program
		.command("epic")
		.description(
			"Roll up an epic: story status breakdown, completion %, total effort (with unestimated count), and blocked/blocking stories. Read-only.",
		)
		.argument("<identifier>", "Plane epic identifier (e.g. DATA-1)")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project the epic belongs to (defaults to defaultProject)")
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.option("--refresh", "Re-fetch the live board and atomically replace its local cache", false)
		.option(
			"--stale-ok",
			"Use a matching cache older than 1h, explicitly acknowledging that it is stale",
			false,
		)
		.action(async (identifier: string, options, command: Command) => {
			try {
				if (options.fromSnapshot && (options.refresh || options.staleOk)) {
					throw new ConfigError(
						"--refresh and --stale-ok apply to the board cache and cannot be combined with --from-snapshot.",
					);
				}
				let client: PlaneClient;
				let resolvedConfig: ResolvedConfig;
				let pacingClient: PlaneClient | undefined;
				if (options.fromSnapshot) {
					const snapshotSource = await openSnapshotSource(String(options.fromSnapshot));
					announceSnapshotSource(snapshotSource, options.json === true);
					resolvedConfig = await loadConfigForSnapshot(options.config, options.context);
					client = asClient(snapshotSource);
				} else {
					const opened = await openBoardCacheOrLive({
						config: options.config,
						context: options.context,
						project: options.project,
						refresh: options.refresh === true,
						staleOk: options.staleOk === true,
						json: options.json === true,
						selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
					});
					client = opened.client;
					resolvedConfig = opened.config;
					pacingClient = opened.pacingClient;
				}

				const { text } = await rollupEpic(client, {
					config: resolvedConfig,
					identifier,
					project: options.project,
				});

				console.log("");
				console.log(text);
				reportPacing(pacingClient ?? client);
			} catch (error) {
				handleError(error);
			}
		});
}
