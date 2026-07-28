import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { type AtlasGraph, buildAtlasFromBoard, buildAtlasFromFile } from "../../atlas/model.ts";
import { renderAtlasHtml } from "../../atlas/render.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient, type PlaneIssueRelations } from "../../plane/client.ts";
import { fetchProjectIndex } from "../../plane/issues.ts";
import { Resolver } from "../../plane/resolvers.ts";
import { isCriterionChild } from "../../sync/board-story.ts";
import { mapWithConcurrency } from "../../utils/concurrency.ts";

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
		.option("--context <name>", "Select a named context from multi-context config")
		.option("-p, --project <name>", "Render the whole live Plane project instead of a file")
		.option("-o, --output <file>", "Output HTML file", "./atlas.html")
		.option("--open", "Open the generated file in your browser", false)
		.option(
			"--no-dependencies",
			"Skip fetching dependency relations for the live board (faster; hierarchy only)",
		)
		.action(async (file: string | undefined, options) => {
			try {
				let graph: AtlasGraph;

				if (file) {
					// Offline: parse one markdown file, no config, no API.
					const content = await Bun.file(file).text();
					graph = buildAtlasFromFile(content, file);
				} else {
					// Live board: pull the whole project via the one-call index.
					const config = await loadConfig({
						configPath: options.config,
						context: options.context,
					});
					const projectName = options.project ?? config.defaultProject;
					if (!projectName) {
						throw new ConfigError(
							"Provide a <file> argument, or --project <name> (or a defaultProject) to render the live board.",
						);
					}
					const client = createPlaneClient({
						apiKey: config.apiKey,
						workspaceSlug: config.workspaceSlug,
						baseUrl: config.baseUrl,
						maxRetries: config.maxRetries,
					});
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
						let failed = 0;
						const pairs = await mapWithConcurrency(items, 4, async (item) => {
							try {
								const relations = await client.getRelations(project.id, item.id);
								return [item.id, relations] as const;
							} catch {
								failed++;
								return null;
							}
						});
						relationsById = new Map(
							pairs.filter((p): p is readonly [string, PlaneIssueRelations] => p !== null),
						);
						if (failed > 0) {
							console.error(
								chalk.yellow(
									`  ${failed}/${items.length} relation lookups failed (rate limit?) — some dependency edges may be missing.`,
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

				const html = renderAtlasHtml(graph);
				const abs = resolve(options.output);
				await Bun.write(abs, html);

				const flagged = graph.counts.flagged ? `, ${graph.counts.flagged} flagged` : "";
				const deps = graph.counts.edges ? `, ${graph.counts.edges} dependencies` : "";
				console.log(
					chalk.green(`Atlas written to ${options.output}`) +
						chalk.dim(
							` (${graph.counts.epics} epics, ${graph.counts.stories} stories${deps}${flagged})`,
						),
				);

				if (options.open) {
					openInBrowser(abs);
				} else {
					console.log(chalk.dim(`Open it: file://${abs}`));
				}
			} catch (error) {
				handleError(error);
			}
		});
}
