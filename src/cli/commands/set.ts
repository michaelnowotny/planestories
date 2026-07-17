import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { setWorkItems } from "../../sync/setter.ts";
import { PLANE_PRIORITIES, type PlanePriority } from "../../types.ts";

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

export function registerSetCommand(program: Command) {
	program
		.command("set")
		.description("Update status/priority/assignee on existing work items by identifier")
		.argument("<identifiers...>", "Work item identifiers, e.g. BLOOM-12")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Project (required if no defaultProject)")
		.option("-s, --status <state>", "Set the state by name (e.g. 'In Progress')")
		.option("--priority <level>", "Set priority: urgent|high|medium|low|none")
		.option("-a, --assignee <email>", "Set the assignee by email")
		.action(async (identifiers: string[], options) => {
			try {
				let priority: PlanePriority | undefined;
				if (options.priority) {
					const value = String(options.priority).toLowerCase();
					if (!PLANE_PRIORITIES.includes(value as PlanePriority)) {
						console.error(
							chalk.red(
								`Invalid --priority "${options.priority}". Use: ${PLANE_PRIORITIES.join(", ")}`,
							),
						);
						process.exit(1);
					}
					priority = value as PlanePriority;
				}

				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
				});

				const summary = await setWorkItems(client, {
					config,
					identifiers,
					project: options.project,
					status: options.status,
					priority,
					assignee: options.assignee,
				});

				console.log("");
				console.log(chalk.bold("Set Summary"));
				console.log(`  Updated: ${chalk.green(String(summary.updated))}`);
				console.log(`  Failed:  ${chalk.red(String(summary.failed))}`);
				for (const r of summary.results) {
					if (r.action === "updated") {
						console.log(chalk.green(`  ~ ${r.identifier}`));
					} else {
						console.log(chalk.red(`  x ${r.identifier}: ${r.error}`));
					}
				}

				if (summary.failed > 0) {
					process.exit(1);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
