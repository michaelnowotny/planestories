import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { instanceTag } from "../../replicate/backup.ts";
import { boardHealth, buildTrend, formatTrend } from "../../sync/trend.ts";
import { resolveGraph } from "../graph_source.ts";
import { openSnapshotSource } from "../snapshot_option.ts";

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

/** Every *.snapshot.json under a directory, non-recursive, sorted by name. */
function snapshotsIn(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".snapshot.json"))
		.map((f) => join(dir, f))
		.filter((f) => statSync(f).isFile())
		.sort();
}

export function registerTrendCommand(program: Command): void {
	program
		.command("trend [files...]")
		.description("Board-health over time from nightly snapshots — offline, zero API calls")
		.option("--dir <path>", "Read every *.snapshot.json in this directory")
		.option("--json", "Emit the series as JSON", false)
		.action(async (files: string[], options) => {
			try {
				const paths = [...(files ?? []), ...(options.dir ? snapshotsIn(String(options.dir)) : [])];
				if (paths.length === 0) {
					throw new ConfigError(
						"Provide snapshot files, or --dir <path> containing *.snapshot.json files.",
					);
				}

				const rows = [];
				const failures: string[] = [];
				for (const path of paths) {
					// One unreadable snapshot must not silently shorten the series: a gap
					// that nobody is told about reads as "nothing changed that week".
					try {
						const source = await openSnapshotSource(path);
						// `boardHealth` counts dependency edges, so a graph missing some of
						// them reports a board shedding structure it never shed. Snapshot
						// reads cannot fail this way today — but that is a property of the
						// current wiring, not a guarantee, and this command used to discard
						// the completeness field outright. Throwing lands in the catch below,
						// which records an unreadable point instead of a quiet fiction.
						const graph = (
							await resolveGraph({
								fromSnapshot: path,
								project: source.projectName,
								json: true, // keep provenance on stderr, out of --json stdout
							})
						).requireCompleteGraph("a board-health point");
						// Workspace slug is the series key: it distinguishes the cloud
						// workspace from the self-hosted one, which is exactly the boundary
						// across which a trend line would be fiction.
						// Series key = host + workspace + PROJECT. A workspace slug alone
						// merges two different projects from one workspace into a single
						// line (DATA 770 -> SBOX 12 reads as a board collapse), and two
						// hosts can share a slug — which is exactly why backup.ts already
						// has instanceTag(). Reusing it rather than inventing a third
						// spelling of "which board is this".
						const key = `${instanceTag(source.baseUrl, source.workspaceSlug)}/${source.projectIdentifier}`;
						rows.push(boardHealth(graph, source.takenAt, key));
					} catch (error) {
						failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}

				if (failures.length > 0) {
					console.error(chalk.yellow(`⚠ ${failures.length} snapshot(s) could not be read:`));
					for (const f of failures) console.error(chalk.yellow(`  ${f}`));
				}
				if (rows.length === 0) {
					throw new ParseError("No snapshot could be read — refusing to report an empty trend.");
				}

				const series = buildTrend(rows);
				if (options.json) {
					console.log(JSON.stringify({ series, unreadable: failures }, null, 1));
				} else {
					console.log(formatTrend(series));
				}
				// Unreadable inputs mean the series is incomplete; a caller scripting
				// this must be able to tell without parsing stderr.
				if (failures.length > 0) process.exitCode = 1;
			} catch (error) {
				handleError(error);
			}
		});
}
