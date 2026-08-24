import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { instanceTag } from "../../replicate/backup.ts";
import { diffGraphs, formatGraphDiff } from "../../sync/graph_diff.ts";
import { resolveGraph } from "../graph_source.ts";
import { openSnapshotSource } from "../snapshot_option.ts";

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

export function registerDiffCommand(program: Command): void {
	program
		.command("diff <before> <after>")
		.description("Structural difference between two snapshots — dependencies, epics, status")
		.option("--json", "Emit the diff as JSON", false)
		.action(async (beforePath: string, afterPath: string, options) => {
			try {
				// Snapshots only. A live board cannot be a diff operand: it moves while
				// you read it, so "what changed" would include your own read window.
				const [sa, sb] = [
					await openSnapshotSource(beforePath),
					await openSnapshotSource(afterPath),
				];
				// An edge missing because a lookup failed is indistinguishable, in this
				// output, from an edge somebody deleted — and the second reads as a fact
				// about the board. So a diff is computed only from two COMPLETE graphs.
				const purpose = "a structural difference";
				const [ga, gb] = [
					(
						await resolveGraph({ fromSnapshot: beforePath, project: sa.projectName, json: true })
					).requireCompleteGraph(purpose),
					(
						await resolveGraph({ fromSnapshot: afterPath, project: sb.projectName, json: true })
					).requireCompleteGraph(purpose),
				];

				const diff = diffGraphs(ga, gb, {
					beforeLabel: `${sa.projectIdentifier} @ ${sa.takenAt.slice(0, 19)}Z`,
					afterLabel: `${sb.projectIdentifier} @ ${sb.takenAt.slice(0, 19)}Z`,
					// SAME KEY AS `trend`: host + workspace, via the shared instanceTag.
					// A bare workspace slug calls two different HOSTS the same instance —
					// which is exactly the case the divergence banner exists for, so it
					// would suppress the warning in the one situation that needs it. Two
					// commits using different definitions of "same board" is the drift
					// this branch has already been blocked for twice.
					beforeInstance: instanceTag(sa.baseUrl, sa.workspaceSlug),
					afterInstance: instanceTag(sb.baseUrl, sb.workspaceSlug),
					beforeProject: sa.projectIdentifier,
					afterProject: sb.projectIdentifier,
				});

				if (options.json) console.log(JSON.stringify(diff, null, 1));
				else console.log(formatGraphDiff(diff));
			} catch (error) {
				handleError(error);
			}
		});
}
