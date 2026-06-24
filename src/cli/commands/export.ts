import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { exportStories } from "../../sync/exporter.ts";
import type { ExportFilters } from "../../types.ts";

/**
 * Print a user-friendly error message and exit.
 */
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

export function registerExportCommand(program: Command) {
	program
		.command("export")
		.description("Export Plane work items to a markdown file")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-o, --output <file>", "Output file path", "./exported-stories.md")
		.option("-p, --project <name>", "Project to export from (required if no defaultProject)")
		.option("-i, --issues <ids>", "Comma-separated work item identifiers (e.g. BLOOM-8)")
		.option("-s, --status <state>", "Filter by status")
		.option("-a, --assignee <email>", "Filter by assignee email")
		.option(
			"--external-source [source]",
			"Only export items stamped with this external_source (default: planestories)",
		)
		.option("-l, --label <name>", "Filter by label name")
		.option("--sync-criteria", "Reconstruct acceptance criteria from sub-items", false)
		.action(async (options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
				});

				const filters: ExportFilters = {};
				if (options.project) filters.project = options.project;
				if (options.issues) filters.issues = options.issues.split(",").map((s: string) => s.trim());
				if (options.status) filters.status = options.status;
				if (options.assignee) filters.assignee = options.assignee;
				if (options.externalSource) {
					filters.externalSource =
						options.externalSource === true ? "planestories" : options.externalSource;
				}
				if (options.label) filters.label = options.label;

				const result = await exportStories(client, {
					config,
					filters,
					project: options.project ?? config.defaultProject ?? undefined,
					outputPath: options.output,
					syncCriteria: options.syncCriteria,
				});

				console.log(chalk.green(`Exported ${result.count} stories to ${result.outputPath}`));
			} catch (error) {
				handleError(error);
			}
		});
}
