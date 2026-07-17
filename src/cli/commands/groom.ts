import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { type GroomReport, groom } from "../../sync/groomer.ts";

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

function printReport(report: GroomReport, applied: boolean): void {
	console.log("");
	console.log(chalk.bold(`Groom ${report.project}${applied ? "" : " — dry run (no changes)"}`));

	// (a) orphaned criterion sub-items.
	if (report.orphanedCriteria.length === 0) {
		console.log(chalk.gray("  No orphaned criterion sub-items (parent done, child still open)."));
	} else if (applied) {
		console.log(
			chalk.green(
				`  Closed ${report.closed} orphaned criterion sub-item(s) (+${report.commentsPosted} comment(s)):`,
			),
		);
	} else {
		console.log(
			chalk.yellow(
				`  Would close ${report.orphanedCriteria.length} orphaned criterion sub-item(s):`,
			),
		);
	}
	for (const c of report.orphanedCriteria) {
		console.log(`    - ${c.identifier} "${c.title}" (parent ${c.parentIdentifier ?? "?"} is done)`);
	}

	// (b) duplicate-title pairs (report only).
	if (report.duplicateTitles.length > 0) {
		console.log(chalk.yellow(`  Duplicate-title work items (${report.duplicateTitles.length}):`));
		for (const d of report.duplicateTitles) {
			console.log(`    - "${d.title}": ${d.identifiers.join(", ")}`);
		}
	}

	// (c) parentless criterion sub-items (report only).
	if (report.parentlessCriteria.length > 0) {
		console.log(
			chalk.yellow(
				`  Open criterion sub-items whose parent no longer exists (${report.parentlessCriteria.length}):`,
			),
		);
		for (const c of report.parentlessCriteria) {
			console.log(`    - ${c.identifier} "${c.title}"`);
		}
	}

	if (!applied && report.orphanedCriteria.length > 0) {
		console.log(chalk.dim("  Re-run with --yes to close the orphaned sub-items."));
	}
}

export function registerGroomCommand(program: Command) {
	program
		.command("groom")
		.description(
			"Reconcile a project: close orphaned criterion sub-items; report duplicate-title and parentless items",
		)
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Project to groom (required if no defaultProject)")
		.option(
			"-y, --yes",
			"Apply changes (close sub-items); without it, only the report is shown",
			false,
		)
		.action(async (options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
				});

				const report = await groom(client, {
					config,
					project: options.project,
					apply: options.yes,
				});

				printReport(report, Boolean(options.yes));
			} catch (error) {
				handleError(error);
			}
		});
}
