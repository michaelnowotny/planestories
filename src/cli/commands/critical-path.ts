import chalk from "chalk";
import type { Command } from "commander";
import type { AtlasGraph } from "../../atlas/model.ts";
import { ParentCycleError } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { type CriticalPathResult, computeCriticalPath } from "../../sync/critical_path.ts";
import { IncompleteGraphError, resolveGraph } from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import { FROM_SNAPSHOT_HELP } from "../snapshot_option.ts";

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

/**
 * Render the result. The formatter is where the honesty lives: `totalDays` may
 * never be printed as a bare figure when `isLowerBound`, and a cycle must read
 * as a REFUSAL rather than as "no dependencies found".
 */
export function formatCriticalPath(result: CriticalPathResult): string {
	const lines: string[] = [];

	if (!result.ok) {
		lines.push(chalk.red("Cannot compute a critical path: the dependency graph has a cycle."));
		lines.push(
			chalk.dim(
				"  A longest path through a cycle is not a longer estimate, it is a meaningless one.",
			),
		);
		for (const cycle of result.cycles) lines.push(`  ${cycle.join(" \u2192 ")}`);
		lines.push(chalk.dim("  Break the cycle on the board, then re-run."));
		return lines.join("\n");
	}

	if (result.chain.length === 0) {
		lines.push("No dependency chain: nothing on this board blocks anything else.");
		lines.push(
			chalk.dim(
				`  ${result.consideredLeaves} stories considered, ${result.connectedLeaves} with a dependency.`,
			),
		);
		return lines.join("\n");
	}

	const bound = result.isLowerBound ? "at least " : "";
	lines.push(
		chalk.bold(
			`Critical path: ${bound}${result.totalDays} dev-days across ${result.chain.length} items`,
		),
	);
	// Say what the number IS. A solo developer will otherwise read it as calendar
	// time, and it is a PARALLEL floor: independent work is excluded by design.
	lines.push(
		chalk.dim(
			"  This is the dependency floor assuming work can run in parallel — not total remaining effort.",
		),
	);
	if (result.isLowerBound) {
		lines.push(
			chalk.yellow(
				`  \u26a0 ${result.unestimated} connected item(s) have no **Effort:** line, on or off this chain — the real floor is HIGHER.`,
			),
		);
	}
	lines.push("");
	for (const [i, node] of result.chain.entries()) {
		const effort =
			node.effortDays === null ? chalk.yellow("?d") : chalk.cyan(`${node.effortDays}d`);
		const state = node.done ? chalk.dim(" (done)") : "";
		lines.push(
			`  ${i === 0 ? " " : "\u21b3"} ${chalk.bold(node.identifier ?? "?")} ${effort}${state}  ${node.title.slice(0, 60)}`,
		);
	}
	if (result.biggestLever) {
		lines.push("");
		lines.push(
			`${chalk.bold("Biggest lever:")} ${result.biggestLever.identifier} — finishing it shortens the floor by ${result.biggestLever.daysSaved} dev-days.`,
		);
	}
	lines.push("");
	const expanded = result.expandedEdges
		? `, ${result.expandedEdges} edge(s) expanded from epic endpoints`
		: "";
	lines.push(
		chalk.dim(
			`${result.consideredLeaves} stories (${result.doneLeaves} done), ${result.connectedLeaves} carry a dependency${expanded}. Items off the chain have slack and do not move the end date.`,
		),
	);
	return lines.join("\n");
}

export function registerCriticalPathCommand(program: Command): void {
	program
		.command("critical-path [file]")
		.description("Longest dependency chain and its dev-day floor, with slack and the biggest lever")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Named context (see --help on any command)")
		.option("-p, --project <name>", "Analyse a live Plane project instead of a file")
		.option("--json", "Emit the full result (chain, slack, counts) as JSON", false)
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.action(async (file: string | undefined, options, command: Command) => {
			try {
				const source = await resolveGraph({
					file,
					selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
					config: options.config,
					context: options.context,
					project: options.project,
					fromSnapshot: options.fromSnapshot,
					json: options.json === true,
				});
				// A partial sweep means the graph is MISSING edges, and a missing
				// `blocks` edge silently SHORTENS the floor or hides a cycle that should
				// have been a refusal. Atlas may draw a picture with most of its edges;
				// a schedule number may not be computed from most of its constraints.
				// The refusal is now the TYPE's — there is no way to reach the graph
				// without answering this.
				let graph: AtlasGraph;
				try {
					graph = source.requireCompleteGraph("the dependency floor");
				} catch (error) {
					if (!(error instanceof IncompleteGraphError)) throw error;
					console.error(chalk.red(error.message));
					console.error(
						chalk.dim(
							"  A missing dependency edge shortens the floor or hides a cycle. Re-run at a quieter hour,",
						),
					);
					console.error(
						chalk.dim("  or use --from-snapshot, which reads a complete recorded graph."),
					);
					if (source.client) reportPacing(source.client);
					process.exitCode = 1;
					return;
				}
				const client = source.client;
				const result = computeCriticalPath(graph);

				if (options.json) {
					console.log(JSON.stringify(result, null, 1));
				} else {
					console.log(formatCriticalPath(result));
				}
				if (client) reportPacing(client);
				// A cycle is a real finding, not a clean run: exit non-zero so a CI
				// gate or a script cannot mistake "refused to compute" for "fine".
				if (!result.ok) process.exitCode = 1;
			} catch (error) {
				handleError(error);
			}
		});
}
