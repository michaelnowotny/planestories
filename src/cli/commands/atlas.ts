import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { type AtlasGraph, buildAtlasFromBoard, buildAtlasFromFile } from "../../atlas/model.ts";
import { fetchRelationsWithSweep } from "../../atlas/relations.ts";
import { renderAtlasHtml } from "../../atlas/render.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import {
	createPlaneClient,
	type PlaneClient,
	type PlaneIssueRelations,
} from "../../plane/client.ts";
import { fetchProjectIndex } from "../../plane/issues.ts";
import { Resolver } from "../../plane/resolvers.ts";
import { isCriterionChild } from "../../sync/board-story.ts";
import { reportPacing } from "../pacing.ts";
import {
	announceSnapshotSource,
	asClient,
	FROM_SNAPSHOT_HELP,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "../snapshot_option.ts";

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
			"Output file (default ./atlas.html, or ./atlas.json with --json)",
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
				let graph: AtlasGraph;
				let pacedClient: PlaneClient | undefined;

				if (file) {
					// Offline: parse one markdown file, no config, no API.
					const content = await Bun.file(file).text();
					graph = buildAtlasFromFile(content, file);
				} else {
					// Live board: pull the whole project via the one-call index.
					const config = options.fromSnapshot
						? await loadConfigForSnapshot(options.config, options.context)
						: await loadConfig({ configPath: options.config, context: options.context });
					const snapshotSource = options.fromSnapshot
						? await openSnapshotSource(String(options.fromSnapshot))
						: null;
					if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);
					const projectName =
						options.project ?? snapshotSource?.projectName ?? config.defaultProject;
					if (!projectName) {
						throw new ConfigError(
							"Provide a <file> argument, or --project <name> (or a defaultProject) to render the live board.",
						);
					}
					const client = snapshotSource
						? asClient(snapshotSource)
						: createPlaneClient({
								apiKey: config.apiKey,
								workspaceSlug: config.workspaceSlug,
								baseUrl: config.baseUrl,
								maxRetries: config.maxRetries,
								dialect: config.dialect,
								requestsPerMinute: config.apiRateLimit,
								rateHeadroom: config.rateHeadroom,
								maxConcurrency: config.maxConcurrency,
							});
					pacedClient = client;
					const resolver = new Resolver(client);
					const project = await resolver.resolveProject(projectName);
					const index = await fetchProjectIndex(client, project.id, project.identifier);
					// Dependency edges need each story/epic's relations (one GET per
					// non-criterion item). Skip with --no-dependencies. On a big board this
					// is many calls, so keep concurrency modest and let a per-item failure
					// (e.g. a 429 that outlived its retries) DROP that item's edges rather
					// than abort the whole atlas — a graph with most edges beats no graph.
					let relationsById: Map<string, PlaneIssueRelations> | undefined;
					if (options.dependencies !== false) {
						const items = index.items.filter((item) => !isCriterionChild(item));
						const result = await fetchRelationsWithSweep(client, project.id, items);
						relationsById = result.relationsById;
						if (result.recovered > 0) {
							console.error(
								chalk.dim(
									`  recovered ${result.recovered} rate-limited relation lookup${result.recovered === 1 ? "" : "s"} in a paced second pass.`,
								),
							);
						}
						if (result.failed > 0) {
							console.error(
								chalk.yellow(
									`  ${result.failed}/${items.length} relation lookups failed even after the paced retry pass — some dependency edges may be missing.`,
								),
							);
						}
					}
					graph = buildAtlasFromBoard(
						client,
						project.id,
						project.identifier,
						projectName,
						index,
						relationsById,
					);
				}

				const html = options.json ? "" : renderAtlasHtml(graph);
				const outPath = options.output ?? (options.json ? "./atlas.json" : "./atlas.html");
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
