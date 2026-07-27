import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { type AtlasGraph, buildAtlasFromBoard, buildAtlasFromFile } from "../../atlas/model.ts";
import { renderAtlasHtml } from "../../atlas/render.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";
import { fetchProjectIndex } from "../../plane/issues.ts";
import { Resolver } from "../../plane/resolvers.ts";

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
					graph = buildAtlasFromBoard(client, project.id, project.identifier, projectName, index);
				}

				const html = renderAtlasHtml(graph);
				const abs = resolve(options.output);
				await Bun.write(abs, html);

				const flagged = graph.counts.flagged ? `, ${graph.counts.flagged} flagged` : "";
				console.log(
					chalk.green(`Atlas written to ${options.output}`) +
						chalk.dim(` (${graph.counts.epics} epics, ${graph.counts.stories} stories${flagged})`),
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
