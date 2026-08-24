import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, PlaneApiError } from "../../errors.ts";
import { formatCapabilitiesTable, probeDeploymentCapabilities } from "../../plane/capabilities.ts";
import { announceTarget } from "../announce_target.ts";
import { connectTarget } from "../target_client.ts";

function handleError(error: unknown): never {
	if (
		error instanceof ParentCycleError ||
		error instanceof ConfigError ||
		error instanceof PlaneApiError
	) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else if (error instanceof Error) {
		console.error(chalk.red(`Error: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

export function registerCapabilitiesCommand(program: Command): void {
	program
		.command("capabilities")
		.description("Probe this Plane deployment's read/query/relation capabilities (read-only)")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("--json", "Emit the same capability report as JSON", false)
		.action(async (options) => {
			try {
				const loaded = await loadConfig({
					configPath: options.config,
					context: options.context,
				});
				const target = await connectTarget(loaded, { project: loaded.defaultProject });
				announceTarget(target.config, options.context);
				const report = await probeDeploymentCapabilities(target.client, {
					dialectSource: target.config.dialectSource ?? "fallback",
					preferredProject: target.config.defaultProject,
				});
				console.log(
					options.json ? JSON.stringify(report, null, 2) : formatCapabilitiesTable(report),
				);
			} catch (error) {
				handleError(error);
			}
		});
}
