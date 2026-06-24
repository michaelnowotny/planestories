import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";

interface ProjectRow {
	name: string;
	identifier: string;
}

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

export function registerProjectsCommand(program: Command) {
	program
		.command("projects")
		.description("List the projects in your Plane workspace (identifier + name)")
		.option("-c, --config <path>", "Config file path")
		.option("--context <name>", "Select a named context from multi-context config")
		.action(async (options) => {
			try {
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
				});

				const projects = await client.listProjects<ProjectRow>();
				if (projects.length === 0) {
					console.log("No projects found in this workspace.");
					return;
				}

				projects.sort((a, b) => a.name.localeCompare(b.name));
				const width = Math.max(...projects.map((p) => (p.identifier ?? "").length));
				console.log(chalk.bold(`Projects in workspace "${config.workspaceSlug}":`));
				for (const project of projects) {
					console.log(`  ${chalk.cyan((project.identifier ?? "").padEnd(width))}  ${project.name}`);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
