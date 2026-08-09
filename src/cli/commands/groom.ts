import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { type GroomReport, groom } from "../../sync/groomer.ts";
import { reverseSyncCriteria, type WriteBackReport } from "../../sync/writeback.ts";

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

function printWriteBack(report: WriteBackReport): void {
	console.log("");
	console.log(
		chalk.bold(
			`Reverse-sync acceptance criteria${report.applied ? "" : " — dry run (no changes)"}`,
		),
	);

	const anyMissing = report.files.some((f) => f.missingOnBoard.length > 0);
	const anyWarnings = report.files.some((f) => f.warnings.length > 0);
	if (report.totalChanges === 0 && !anyMissing && !anyWarnings) {
		console.log(chalk.gray("  All checkboxes already match the board."));
	}

	for (const file of report.files) {
		if (
			file.changes.length === 0 &&
			file.missingOnBoard.length === 0 &&
			file.warnings.length === 0
		) {
			continue;
		}
		console.log(
			`  ${chalk.cyan(file.filePath)} (${file.linkedStories} linked, ${file.unlinkedStories} unlinked)`,
		);
		for (const change of file.changes) {
			const arrow = `[${change.from ? "x" : " "}] → [${change.to ? "x" : " "}]`;
			const dir = change.to ? "tick" : "untick";
			const verb = report.applied ? `${dir}ed` : `would ${dir}`;
			console.log(
				`    ${report.applied ? chalk.green(arrow) : chalk.yellow(arrow)} ${chalk.dim(
					`${change.identifier ?? change.title} #${change.position}`,
				)} ${change.text} ${chalk.dim(`(${verb})`)}`,
			);
		}
		for (const warning of file.warnings) {
			console.log(chalk.yellow(`    ! ${warning}`));
		}
		for (const missing of file.missingOnBoard) {
			console.log(
				chalk.yellow(`    ! ${missing} is linked but not found on the board (stale link?)`),
			);
		}
	}

	if (!report.applied && report.totalChanges > 0) {
		console.log(chalk.dim("  Re-run with --yes to write these boxes to the file(s)."));
	}
}

export function registerGroomCommand(program: Command) {
	program
		.command("groom")
		.description(
			"Reconcile a project: close orphaned criterion sub-items; report duplicate-title and parentless items. With --write-back <files>, INSTEAD reverse-sync criterion done-state board→file (no board writes).",
		)
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project to groom (required if no defaultProject)")
		.option(
			"--write-back <files...>",
			"Reverse-sync acceptance-criteria checkbox state board→file, in place (ticks/unticks - [x] to match each criterion sub-item's board status)",
		)
		.option(
			"-y, --yes",
			"Apply changes (close sub-items and/or write checkbox state); without it, only the report is shown",
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

				const writeBackFiles: string[] = options.writeBack ?? [];

				// --write-back is a FOCUSED, file-only mode: it reverse-syncs checkbox
				// state board→file and makes NO board writes. It deliberately does NOT
				// also run the board-side orphan-close — otherwise `groom --write-back
				// f.md --yes` with a defaultProject set would silently close sub-items on
				// that default board. Run plain `groom` for the board-side reconcile.
				if (writeBackFiles.length > 0) {
					const writeBack = await reverseSyncCriteria(client, {
						config,
						files: writeBackFiles,
						project: options.project,
						apply: options.yes,
					});
					printWriteBack(writeBack);
				} else {
					const report = await groom(client, {
						config,
						project: options.project,
						apply: options.yes,
					});
					printReport(report, Boolean(options.yes));
				}
			} catch (error) {
				handleError(error);
			}
		});
}
