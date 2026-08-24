import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import type { PlaneClient } from "../../plane/client.ts";
import { fetchProjectIndex } from "../../plane/issues.ts";
import { Resolver } from "../../plane/resolvers.ts";
import { parseSnapshot } from "../../replicate/snapshot.ts";
import { SnapshotSource } from "../../replicate/snapshot_source.ts";
import { isOwnedCriterionChild } from "../../sync/board-story.ts";
import { checkDependencyGraph } from "../../sync/graph_check.ts";
import { groom } from "../../sync/groomer.ts";
import { checkHouseRules, type HouseRuleFindings } from "../../sync/house_rules.ts";
import { checkCriteriaMigration } from "../../sync/migrate.ts";
import { announceTarget } from "../announce_target.ts";
import { reportPacing } from "../pacing.ts";
import {
	announceSnapshotSource,
	loadConfigForSnapshot,
	snapshotProvenance,
} from "../snapshot_option.ts";
import { connectTarget } from "../target_client.ts";

function handleError(error: unknown): never {
	if (
		error instanceof ParentCycleError ||
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

export function assembleDoctorReport(
	base: Record<string, unknown> & { findings: number },
	houseRules?: HouseRuleFindings,
): Record<string, unknown> & { findings: number } {
	if (!houseRules) return base;
	return {
		...base,
		findings:
			base.findings + houseRules.missingEffort.length + houseRules.proseDepsWithoutRelation.length,
		houseRules,
	};
}

export function registerDoctorCommand(program: Command) {
	program
		.command("doctor")
		.description(
			"CI health check: report board rot (orphaned criterion sub-items, duplicate titles, parentless sub-items). Exits non-zero on findings unless --no-fail-on-findings.",
		)
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project to check (required if no defaultProject)")
		.option("--no-fail-on-findings", "Report findings but always exit 0")
		.option("--house-rules", "Check open-work effort and board-side dependency conventions", false)
		.option("--json", "Emit the report as JSON (machine-readable acceptance gate)", false)
		.option(
			"--from-snapshot <file>",
			"Analyse a snapshot file instead of the live board: ZERO API calls, works offline, and possible when the instance is rate-limiting you. The report states the snapshot's age.",
		)
		.action(async (options) => {
			try {
				let config = options.fromSnapshot
					? await loadConfigForSnapshot(options.config, options.context)
					: await loadConfig({ configPath: options.config, context: options.context });
				// A snapshot contains exactly what doctor enumerates, so it can stand in for
				// the instance entirely. The one rule: say so, and print its age — a stale
				// answer presented as a live one is worse than no answer.
				const snapshotSource = options.fromSnapshot
					? new SnapshotSource(parseSnapshot(await Bun.file(String(options.fromSnapshot)).text()))
					: null;
				let client = snapshotSource as unknown as PlaneClient | null;
				if (!client) {
					const target = await connectTarget(config, { project: options.project });
					config = target.config;
					client = target.client;
					announceTarget(config, options.context, options.project);
				}
				// stderr, so --json stdout stays machine-clean; and INSIDE the payload, so a
				// stored CI artifact cannot be mistaken for a live reading later.
				if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);

				// Read-only: groom without apply is a pure analysis.
				const report = await groom(client, { config, project: options.project });

				// Board-side dependency-graph hygiene (dangling relations).
				const resolver = new Resolver(client);
				const project = await resolver.resolveProject(
					options.project ?? config.defaultProject ?? report.project,
				);
				const index = await fetchProjectIndex(client, project.id, project.identifier);
				// Doctor's relation sweep is one GET per non-criterion item — ~800 on a large board,
				// and against a rate-limited instance it can run for many minutes. Silence there is
				// indistinguishable from a hang, so report progress on a throttled stderr line
				// (stderr keeps --json output clean).
				let lastTick = 0;
				const graph = await checkDependencyGraph(
					client,
					project.id,
					project.identifier,
					index,
					(done, total, retry) => {
						// Nothing to wait for when the source is a file — the progress line
						// exists to distinguish "slow network sweep" from "hung".
						if (snapshotSource) return;
						if (retry) {
							// The sequential recovery pass is the slow tail on a throttled
							// instance; without this the counter reaches N/N and goes quiet.
							process.stderr.write(
								`\r  retrying rate-limited lookups ${retry.retrying}/${retry.toRetry}...`,
							);
							if (retry.retrying === retry.toRetry) process.stderr.write("\n");
							return;
						}
						if (done !== total && done - lastTick < 25) return;
						lastTick = done;
						process.stderr.write(`\r  scanning dependencies ${done}/${total}...`);
						if (done === total) process.stderr.write("\n");
					},
				);

				// Criteria-representation drift (legacy ::ac<n> children vs the
				// description task-list model). Points the operator at `migrate-criteria`.
				const criteria = checkCriteriaMigration(index, project.identifier);
				const houseRules = options.houseRules
					? checkHouseRules(index, graph.relations, project.identifier)
					: undefined;

				// Post-migration ledger: how many owned ::ac children sit closed on the
				// board (migrate closes, never deletes — this is the residue count).
				const closedCriterionChildren = index.items.filter(
					(i) =>
						isOwnedCriterionChild(i) &&
						(i.stateGroup === "completed" || i.stateGroup === "cancelled"),
				).length;

				const baseFindings =
					report.orphanedCriteria.length +
					report.duplicateTitles.length +
					report.parentlessCriteria.length +
					graph.dangling.length +
					criteria.unmigrated.length +
					criteria.dual.length;
				const reportObject = assembleDoctorReport(
					{
						project: project.identifier,
						...snapshotProvenance(snapshotSource),
						findings: baseFindings,
						orphanedCriteria: report.orphanedCriteria,
						duplicateTitles: report.duplicateTitles,
						parentlessCriteria: report.parentlessCriteria,
						danglingRelations: graph.dangling,
						criteria,
						ledger: { closedCriterionChildren },
					},
					houseRules,
				);
				const findings = reportObject.findings;

				if (options.json) {
					console.log(JSON.stringify(reportObject, null, 1));
					reportPacing(client);
					if (findings > 0 && options.failOnFindings !== false) {
						process.exitCode = 1;
					}
					return;
				}

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
				console.log(
					`  Unmigrated criteria (::ac children, no list): ${criteria.unmigrated.length}`,
				);
				console.log(`  Dual criteria (list + open ::ac children):    ${criteria.dual.length}`);
				if (houseRules) {
					console.log(
						`  Open stories missing effort:                   ${houseRules.missingEffort.length}`,
					);
					console.log(
						`  Prose dependencies missing relations:          ${houseRules.proseDepsWithoutRelation.length}`,
					);
				}
				console.log(
					chalk.dim(`  Ledger: closed ::ac children on the board:    ${closedCriterionChildren}`),
				);

				for (const c of criteria.unmigrated) {
					console.log(
						chalk.yellow(`    unmigrated: ${c.identifier} "${c.title}" — run migrate-criteria`),
					);
				}
				for (const c of criteria.dual) {
					console.log(
						chalk.yellow(
							`    dual-representation: ${c.identifier} "${c.title}" (${c.openChildren} open ::ac child(ren)) — run migrate-criteria`,
						),
					);
				}

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
				for (const item of houseRules?.missingEffort ?? []) {
					console.log(chalk.yellow(`    missing effort: ${item.identifier} ${item.title}`));
				}
				for (const item of houseRules?.proseDepsWithoutRelation ?? []) {
					const missing = item.missing.length ? item.missing.join(", ") : "—";
					const unknown = item.unknownTargets.length ? item.unknownTargets.join(", ") : "—";
					console.log(
						chalk.yellow(
							`    ${item.identifier}  ${item.title}  missing: ${missing}  unknown: ${unknown}`,
						),
					);
				}

				if (findings === 0) {
					console.log(chalk.green("  Clean — no board rot found."));
				} else {
					console.log(chalk.red(`  ${findings} finding(s).`));
					// Commander converts --no-fail-on-findings to failOnFindings: false.
					// exitCode (not exit) so the pacing line below still prints — a
					// run WITH findings is exactly the one whose cost you want to see.
					if (options.failOnFindings !== false) {
						process.exitCode = 1;
					}
				}
				reportPacing(client);
			} catch (error) {
				handleError(error);
			}
		});
}
