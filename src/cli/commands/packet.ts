import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { generatePacket } from "../../sync/packet.ts";
import { announceTarget } from "../announce_target.ts";
import { resolveOutputPath } from "../output_path.ts";
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

export function registerPacketCommand(program: Command) {
	program
		.command("packet")
		.description(
			"Emit a self-contained implementable brief for a coding agent from a board ticket (an epic emits itself + every descendant, nested epics included). Prints to stdout unless -o is given.",
		)
		.argument("<identifier>", "Plane work-item identifier (e.g. DATA-123)")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option(
			"-p, --project <name>",
			"Project the identifier belongs to (defaults to defaultProject)",
		)
		.option("-o, --output <file>", "Write the packet to a file instead of stdout")
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

				const { markdown, packet } = await generatePacket(client, {
					config,
					identifier,
					project: options.project,
				});

				if (options.output) {
					const abs = resolveOutputPath(options.output, `${identifier}.md`); // -o is set here
					await Bun.write(abs, markdown);
					const childNote =
						packet.kind === "epic" ? ` (epic + ${packet.children.length} child brief(s))` : "";
					console.error(
						chalk.green(`Wrote packet for ${packet.root.identifier}${childNote} → ${abs}`),
					);
				} else {
					// The packet itself goes to stdout so it can be piped to an agent.
					process.stdout.write(markdown);
				}
				reportPacing(client);
			} catch (error) {
				handleError(error);
			}
		});
}
