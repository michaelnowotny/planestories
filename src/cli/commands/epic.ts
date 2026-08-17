import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { rollupEpic } from "../../sync/rollup.ts";
import { reportPacing } from "../pacing.ts";
import {
	announceSnapshotSource,
	asClient,
	FROM_SNAPSHOT_HELP,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "../snapshot_option.ts";

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
		.action(async (identifier: string, options) => {
			try {
				const config = options.fromSnapshot
					? await loadConfigForSnapshot(options.config, options.context)
					: await loadConfig({ configPath: options.config, context: options.context });
				const snapshotSource = options.fromSnapshot
					? await openSnapshotSource(String(options.fromSnapshot))
					: null;
				if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);
				const client = snapshotSource
					? asClient(snapshotSource)
					: createPlaneClient({
							apiKey: config.apiKey,
							workspaceSlug: config.workspaceSlug,
							baseUrl: config.baseUrl,
							maxRetries: config.maxRetries,
							dialect: config.dialect,
							requestsPerMinute: config.apiRateLimit,
							rateHeadroom: config.rateHeadroom,
							maxConcurrency: config.maxConcurrency,
						});

				const { text } = await rollupEpic(client, {
					config,
					identifier,
					project: options.project,
				});

				console.log("");
				console.log(text);
				reportPacing(client);
			} catch (error) {
				handleError(error);
			}
		});
}
