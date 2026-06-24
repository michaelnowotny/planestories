import chalk from "chalk";
import type { Command } from "commander";
import { glob } from "glob";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { type DeleteSummary, deleteStories } from "../../sync/deleter.ts";

async function resolveGlobs(patterns: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const pattern of patterns) {
		allFiles.push(...(await glob(pattern)));
	}
	return [...new Set(allFiles)];
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

function printSummary(summary: DeleteSummary, archive: boolean): void {
	const verb = archive ? "archive" : "delete";
	console.log("");

	// Nothing planned.
	if (summary.planned === 0) {
		console.log(chalk.yellow("No matching work items to delete."));
		return;
	}

	// Plan-only (dry-run, or not confirmed): list what WOULD go.
	if (!summary.confirmed || summary.dryRun) {
		console.log(chalk.bold(`Would ${verb} ${summary.planned} work item(s):`));
		for (const r of summary.results) {
			console.log(`  - ${r.target.label}`);
		}
		if (summary.dryRun) {
			console.log(chalk.dim("\nDry run — nothing was changed."));
		} else {
			console.log(
				chalk.yellow(`\nNothing ${verb}d. Re-run with --yes to ${verb} (or --dry-run to preview).`),
			);
		}
		return;
	}

	// Confirmed run.
	console.log(chalk.bold(`${archive ? "Archive" : "Delete"} Summary`));
	console.log(
		`  ${archive ? "Archived" : "Deleted"}: ${chalk.green(String(archive ? summary.archived : summary.deleted))}`,
	);
	console.log(`  Failed:  ${chalk.red(String(summary.failed))}`);
	for (const r of summary.results) {
		if (r.action === "deleted" || r.action === "archived") {
			console.log(chalk.green(`  - ${r.action} ${r.target.label}`));
		} else if (r.action === "failed") {
			console.log(chalk.red(`  x ${r.target.label}: ${r.error}`));
		}
	}
}

export function registerDeleteCommand(program: Command) {
	program
		.command("delete")
		.description("Delete (or archive) Plane work items — scoped to files or an external_source")
		.argument("[files...]", "Markdown files whose plane_ids should be deleted")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Project (required for --external-source)")
		.option(
			"--external-source [source]",
			"Delete items stamped with this external_source (default: planestories); requires --project",
		)
		.option("--archive", "Archive instead of hard delete (only completed/cancelled items)", false)
		.option("--dry-run", "Show what would be deleted, change nothing", false)
		.option("-y, --yes", "Confirm deletion (required to actually delete)", false)
		.option("--no-write-back", "Don't clear plane_* out of files after deletion")
		.action(async (filePatterns: string[], options) => {
			try {
				const files = filePatterns.length > 0 ? await resolveGlobs(filePatterns) : [];
				const externalSource =
					options.externalSource === true ? "planestories" : options.externalSource || undefined;

				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
				});

				const summary = await deleteStories(client, {
					config,
					files: files.length > 0 ? files : undefined,
					project: options.project,
					externalSource,
					archive: options.archive,
					dryRun: options.dryRun,
					confirmed: options.yes,
					noWriteBack: !options.writeBack,
				});

				printSummary(summary, Boolean(options.archive));

				if (summary.failed > 0) {
					process.exit(1);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
