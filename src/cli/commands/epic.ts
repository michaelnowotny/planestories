import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { rollupEpic } from "../../sync/rollup.ts";
import { announceTarget } from "../announce_target.ts";
import { reportPacing } from "../pacing.ts";
import {
	announceSnapshotSource,
	asClient,
	FROM_SNAPSHOT_HELP,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "../snapshot_option.ts";
import { connectTarget } from "../target_client.ts";

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
				let config = options.fromSnapshot
					? await loadConfigForSnapshot(options.config, options.context)
					: await loadConfig({ configPath: options.config, context: options.context });
				const snapshotSource = options.fromSnapshot
					? await openSnapshotSource(String(options.fromSnapshot))
					: null;
				if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);
				let client = snapshotSource ? asClient(snapshotSource) : undefined;
				if (!client) {
					const target = await connectTarget(config, { project: options.project });
					config = target.config;
					client = target.client;
					announceTarget(config, options.context, options.project);
				}

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
