import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { renderAtlasHtml } from "../../atlas/render.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { resolveGraph } from "../graph_source.ts";
import { resolveOutputPath } from "../output_path.ts";
import { reportPacing } from "../pacing.ts";
import { FROM_SNAPSHOT_HELP } from "../snapshot_option.ts";

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

function openInBrowser(absPath: string): void {
	const cmd =
		process.platform === "darwin"
			? ["open", absPath]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", absPath]
				: ["xdg-open", absPath];
	try {
		Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
	} catch {
		// Opening is best-effort; the path is printed regardless.
	}
}

export function registerAtlasCommand(program: Command) {
	program
		.command("atlas")
		.description(
			"Render a self-contained Project Atlas (offline HTML) for a stories file or a live Plane project",
		)
		.argument("[file]", "Markdown stories file (omit and use --project to render the live board)")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Render the whole live Plane project instead of a file")
		.option(
			"-o, --output <file>",
			"Output file (default exports/atlas.html, or exports/atlas.json with --json)",
		)
		.option(
			"--json",
			"Emit the graph as JSON (nodes with effort/priority/assignee, dependency edges, counts) instead of HTML",
			false,
		)
		.option("--open", "Open the generated file in your browser", false)
		.option(
			"--no-dependencies",
			"Skip fetching dependency relations for the live board (faster; hierarchy only)",
		)
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.action(async (file: string | undefined, options) => {
			try {
				// ONE graph-construction path, shared with `critical-path` and `trend`.
				// This used to be a 70-line twin of resolveGraph; two sites assembling
				// the same graph is the shape that produced the relation-ref defect,
				// where five call sites did one job and one did it differently.
				const { graph, client: pacedClient } = await resolveGraph({
					file,
					config: options.config,
					context: options.context,
					project: options.project,
					fromSnapshot: options.fromSnapshot,
					dependencies: options.dependencies,
					json: options.json === true,
				});

				const html = options.json ? "" : renderAtlasHtml(graph);
				const outPath = resolveOutputPath(
					options.output,
					options.json ? "atlas.json" : "atlas.html",
				);
				const abs = resolve(outPath);
				await Bun.write(abs, options.json ? `${JSON.stringify(graph, null, "\t")}\n` : html);

				const flagged = graph.counts.flagged ? `, ${graph.counts.flagged} flagged` : "";
				const deps = graph.counts.edges ? `, ${graph.counts.edges} dependencies` : "";
				console.log(
					chalk.green(
						`Atlas ${options.json ? "graph JSON" : ""} written to ${outPath}`.replace("  ", " "),
					) +
						chalk.dim(
							` (${graph.counts.epics} epics, ${graph.counts.stories} stories${deps}${flagged})`,
						),
				);

				if (options.open) {
					openInBrowser(abs);
				} else {
					console.log(chalk.dim(`Open it: file://${abs}`));
				}
				if (pacedClient) reportPacing(pacedClient);
			} catch (error) {
				handleError(error);
			}
		});
}
