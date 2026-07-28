import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { fetchProjectIndex } from "../../plane/issues.ts";
import { Resolver } from "../../plane/resolvers.ts";
import { checkDependencyGraph } from "../../sync/graph_check.ts";
import { groom } from "../../sync/groomer.ts";

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

export function registerDoctorCommand(program: Command) {
	program
		.command("doctor")
		.description(
			"CI health check: report board rot (orphaned criterion sub-items, duplicate titles, parentless sub-items). Exits non-zero on findings unless --no-fail-on-findings.",
		)
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Project to check (required if no defaultProject)")
		.option("--no-fail-on-findings", "Report findings but always exit 0")
		.action(async (options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
				});

				// Read-only: groom without apply is a pure analysis.
				const report = await groom(client, { config, project: options.project });

				// Board-side dependency-graph hygiene (dangling relations).
				const resolver = new Resolver(client);
				const project = await resolver.resolveProject(
					options.project ?? config.defaultProject ?? report.project,
				);
				const index = await fetchProjectIndex(client, project.id, project.identifier);
				const graph = await checkDependencyGraph(client, project.id, project.identifier, index);

				const findings =
					report.orphanedCriteria.length +
					report.duplicateTitles.length +
					report.parentlessCriteria.length +
					graph.dangling.length;

				console.log("");
				console.log(chalk.bold(`Doctor ${report.project}`));
				console.log(
					`  Orphaned criterion sub-items (parent done): ${report.orphanedCriteria.length}`,
				);
				console.log(
					`  Duplicate-title work items:                 ${report.duplicateTitles.length}`,
				);
				console.log(
					`  Parentless criterion sub-items:             ${report.parentlessCriteria.length}`,
				);
				console.log(`  Dangling relations (target missing):        ${graph.dangling.length}`);

				for (const c of report.orphanedCriteria) {
					console.log(
						chalk.yellow(`    orphaned: ${c.identifier} (parent ${c.parentIdentifier ?? "?"})`),
					);
				}
				for (const d of report.duplicateTitles) {
					console.log(chalk.yellow(`    duplicate: "${d.title}" -> ${d.identifiers.join(", ")}`));
				}
				for (const c of report.parentlessCriteria) {
					console.log(chalk.yellow(`    parentless: ${c.identifier}`));
				}
				for (const d of graph.dangling) {
					console.log(chalk.yellow(`    dangling: ${d.from} ${d.relation} -> ${d.targetId}`));
				}

				if (findings === 0) {
					console.log(chalk.green("  Clean — no board rot found."));
				} else {
					console.log(chalk.red(`  ${findings} finding(s).`));
					// Commander converts --no-fail-on-findings to failOnFindings: false.
					if (options.failOnFindings !== false) {
						process.exit(1);
					}
				}
			} catch (error) {
				handleError(error);
			}
		});
}
