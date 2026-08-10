import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { type MigrateReport, migrateCriteria } from "../../sync/migrate.ts";

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

function printReport(report: MigrateReport): void {
	const dry = report.applied ? "" : " — dry run (no changes)";
	console.log("");
	console.log(chalk.bold(`Migrate criteria → description task-lists · ${report.project}${dry}`));

	console.log(
		chalk.dim(
			"  Board-only. After applying, run `export` to regenerate the linked story files from the\n" +
				"  migrated board (they now carry the folded criteria + states), THEN import (a warm\n" +
				"  no-op). Importing a stale pre-migration file first would overwrite the migrated board.",
		),
	);

	const verb = report.applied ? "Migrated" : "Would migrate";
	if (report.migrated.length === 0) {
		console.log(chalk.gray("  No parents to migrate (no un-migrated ::ac<n> children found)."));
	} else {
		console.log(
			chalk.green(
				`  ${verb} ${report.migrated.length} parent(s), folding ${report.criteriaFolded} criterion(s) into descriptions:`,
			),
		);
		for (const p of report.migrated) {
			console.log(
				`    - ${p.identifier} "${p.title}" (${p.criteria} criteria, ${p.openChildren} open child(ren) closed)`,
			);
		}
	}

	if (report.alreadyMigrated.length > 0) {
		const closed = report.alreadyMigrated.reduce((n, p) => n + p.openChildren, 0);
		console.log(
			chalk.yellow(
				`  ${report.alreadyMigrated.length} parent(s) already had a description checklist${
					closed > 0
						? ` — ${report.applied ? "closed" : "would close"} ${closed} leftover open child(ren)`
						: ""
				}.`,
			),
		);
	}

	if (report.onlyUnmatched.length > 0) {
		console.log(
			chalk.red(
				`  --only ids matching NO migration candidate (typo? no ::ac children? already migrated?): ${report.onlyUnmatched.join(", ")}`,
			),
		);
	}

	if (report.conflicts.length > 0) {
		console.log(
			chalk.red(`  ${report.conflicts.length} parent(s) SKIPPED (conflict — fix by hand):`),
		);
		for (const c of report.conflicts) {
			console.log(`    - ${c.identifier} "${c.title}": ${c.reason}`);
		}
	}

	console.log(
		chalk.dim(
			`  Totals: ${report.criteriaFolded} criteria folded, ${report.childrenClosed} children closed${
				report.deferred > 0 ? `, ${report.deferred} parent(s) deferred past --limit` : ""
			}.`,
		),
	);
	if (!report.applied && (report.migrated.length > 0 || report.alreadyMigrated.length > 0)) {
		console.log(chalk.dim("  Re-run with --yes to apply."));
	}
}

export function registerMigrateCriteriaCommand(program: Command) {
	program
		.command("migrate-criteria")
		.description(
			"Fold legacy `::ac<n>` criterion sub-items into their parent's description as a TipTap task-list, then close the children. Idempotent; dry-run by default.",
		)
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project to migrate (required if no defaultProject)")
		.option("--limit <n>", "Max parents to migrate this run (rate-limit batching)", (v) =>
			Number(v),
		)
		.option(
			"--only <ids>",
			"Comma-separated parent identifiers to migrate (deliberate canary; repeatable; ignores --limit)",
			(value: string, previous: string[]) => previous.concat(value.split(",").map((s) => s.trim())),
			[] as string[],
		)
		.option(
			"--json",
			"Emit the report as JSON (machine-readable; suppresses the text report)",
			false,
		)
		.option("-y, --yes", "Apply changes; without it, only the report is shown", false)
		.action(async (options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
					dialect: config.dialect,
				});
				const report = await migrateCriteria(client, {
					config,
					project: options.project,
					limit: options.limit,
					only: options.only,
					apply: options.yes,
				});
				if (options.json) {
					console.log(JSON.stringify(report, null, 1));
				} else {
					printReport(report);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
