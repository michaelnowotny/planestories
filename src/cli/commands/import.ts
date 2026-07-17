import chalk from "chalk";
import type { Command } from "commander";
import { glob } from "glob";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { importStories } from "../../sync/importer.ts";
import type { ImportSummary } from "../../types.ts";

/**
 * Resolve an array of file paths / glob patterns into deduplicated file paths.
 */
async function resolveGlobs(patterns: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const pattern of patterns) {
		const matches = await glob(pattern);
		allFiles.push(...matches);
	}
	// Deduplicate while preserving order
	return [...new Set(allFiles)];
}

/** Print the shared label-summary lines (created / skipped). */
function printLabelSummary(summary: ImportSummary): void {
	if (summary.labelsCreated.length > 0) {
		console.log(chalk.green(`  Labels created: ${summary.labelsCreated.join(", ")}`));
	}
	if (summary.labelsSkipped.length > 0) {
		console.log(
			chalk.yellow(
				`  Labels skipped: ${summary.labelsSkipped.join(", ")} (use --create-labels to create)`,
			),
		);
	}
}

/** Print a dry-run preview: what WOULD happen, plus any validation findings. */
function printDryRun(summary: ImportSummary, checked: boolean): void {
	const wouldCreate = summary.results.filter((r) => r.wouldAction === "create").length;
	const wouldUpdate = summary.results.filter((r) => r.wouldAction === "update").length;

	console.log("");
	console.log(chalk.bold(`Dry run${checked ? " (validated)" : ""} — no changes made`));
	console.log(`  Stories:      ${summary.total}`);
	console.log(`  Would create: ${chalk.green(String(wouldCreate))}`);
	console.log(`  Would update: ${chalk.blue(String(wouldUpdate))}`);
	console.log(`  Unchanged:    ${chalk.gray(String(summary.unchanged))}`);
	if (checked) {
		console.log(`  Invalid:      ${chalk.red(String(summary.failed))}`);
	}

	for (const result of summary.results) {
		if (result.action === "failed") {
			console.log(chalk.red(`  x ${result.story.title}: ${result.error}`));
			continue;
		}
		if (result.action === "unchanged") {
			console.log(chalk.gray(`  = unchanged: ${result.story.title}`));
			continue;
		}
		const mark = result.wouldAction === "update" ? chalk.blue("~") : chalk.green("+");
		const verb = result.wouldAction === "update" ? "would update" : "would create";
		const note = result.note ? chalk.yellow(` (⚠ ${result.note})`) : "";
		console.log(`  ${mark} ${verb}: ${result.story.title}${note}`);
	}

	printLabelSummary(summary);
}

/** Print the summary after a real import. */
function printSummary(summary: ImportSummary): void {
	console.log("");
	console.log(chalk.bold("Import Summary"));
	console.log(`  Total:     ${summary.total}`);
	console.log(`  Created:   ${chalk.green(String(summary.created))}`);
	console.log(`  Updated:   ${chalk.blue(String(summary.updated))}`);
	console.log(`  Unchanged: ${chalk.gray(String(summary.unchanged))}`);
	console.log(`  Skipped:   ${chalk.yellow(String(summary.skipped))}`);
	console.log(`  Failed:    ${chalk.red(String(summary.failed))}`);

	for (const result of summary.results) {
		const id = result.planeIdentifier ?? "";
		if (result.action === "created") {
			console.log(chalk.green(`  + ${id} ${result.story.title}`));
		} else if (result.action === "updated") {
			console.log(chalk.blue(`  ~ ${id} ${result.story.title}`));
		} else if (result.action === "failed") {
			console.log(chalk.red(`  x ${result.story.title}: ${result.error}`));
		}
	}

	printLabelSummary(summary);
	printBoardLinks(summary);
}

/** Print distinct "view in Plane" board links for the projects we wrote to. */
function printBoardLinks(summary: ImportSummary): void {
	const urls = new Set<string>();
	for (const result of summary.results) {
		if ((result.action === "created" || result.action === "updated") && result.projectUrl) {
			urls.add(result.projectUrl);
		}
	}
	for (const url of urls) {
		console.log(chalk.dim(`  View in Plane: ${url}`));
	}
}

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

export function registerImportCommand(program: Command) {
	program
		.command("import")
		.description("Import user stories from markdown files to Plane")
		.argument("<files...>", "Markdown file paths or glob patterns")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Force all stories into this project (overrides frontmatter)")
		.option("--create-labels", "Create labels that don't exist instead of skipping them", false)
		.option("--source-label <name>", "Tag every created item with this label (auto-created)")
		.option("--sync-criteria", "Sync each acceptance criterion to a Plane sub-item", false)
		.option("--force", "Re-import even when content is unchanged (bypass skip-unchanged)", false)
		.option("--dry-run", "Preview without writing to Plane", false)
		.option(
			"--check",
			"With --dry-run, validate against Plane read-only (project/state/assignee/labels)",
			false,
		)
		.option("--no-write-back", "Skip writing Plane IDs back to markdown")
		.action(async (filePatterns: string[], options) => {
			try {
				// Resolve glob patterns to file paths
				const files = await resolveGlobs(filePatterns);
				if (files.length === 0) {
					console.error(chalk.red("No files matched the provided patterns."));
					process.exit(1);
				}

				// Load config
				const config = await loadConfig({ configPath: options.config, context: options.context });

				// Create client
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
				});

				// Import
				const summary = await importStories(client, {
					files,
					config,
					project: options.project,
					dryRun: options.dryRun,
					check: options.check,
					createLabels: options.createLabels,
					sourceLabel: options.sourceLabel,
					syncCriteria: options.syncCriteria,
					force: options.force,
					noWriteBack: !options.writeBack, // Commander converts --no-write-back to writeBack: false
				});

				if (options.dryRun) {
					printDryRun(summary, Boolean(options.check));
				} else {
					printSummary(summary);
				}

				// Exit with error code if any failures (incl. failed validation in --check)
				if (summary.failed > 0) {
					process.exit(1);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
