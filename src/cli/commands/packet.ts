import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { generatePacket } from "../../sync/packet.ts";

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
		.action(async (identifier: string, options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
					dialect: config.dialect,
				});

				const { markdown, packet } = await generatePacket(client, {
					config,
					identifier,
					project: options.project,
				});

				if (options.output) {
					const abs = resolve(options.output);
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
			} catch (error) {
				handleError(error);
			}
		});
}
