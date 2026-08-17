import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, PlaneApiError, ReplicateError } from "../../errors.ts";
import { createPlaneClient } from "../../plane/client.ts";

interface ProjectRow {
	id: string;
	name: string;
	identifier: string;
}

export interface RenameProjectClient {
	listProjects<T>(): Promise<T[]>;
	updateProject<T>(projectId: string, body: Record<string, unknown>): Promise<T>;
}

export interface RenameProjectOptions {
	project: string;
	name?: string;
	identifier?: string;
	yes: boolean;
}

export interface RenameProjectResult {
	dryRun: boolean;
	projectId: string;
	current: { name: string; identifier: string };
	proposed: { name: string; identifier: string };
	identifierChanged: boolean;
}

export async function renameProject(
	client: RenameProjectClient,
	options: RenameProjectOptions,
): Promise<RenameProjectResult> {
	if (options.name === undefined && options.identifier === undefined) {
		throw new ConfigError("rename-project requires at least one of --name or --identifier");
	}
	const projects = await client.listProjects<ProjectRow>();
	const matches = [
		...new Map(
			projects
				.filter(
					(project) =>
						project.identifier.toLowerCase() === options.project.toLowerCase() ||
						project.name === options.project,
				)
				.map((project) => [project.id, project]),
		).values(),
	];
	if (matches.length !== 1) {
		throw new ReplicateError(
			matches.length === 0
				? `Project "${options.project}" not found`
				: `Project reference "${options.project}" is ambiguous (${matches.length} exact-name matches)`,
		);
	}
	const project = matches[0]!;
	const proposed = {
		name: options.name ?? project.name,
		identifier: options.identifier ?? project.identifier,
	};
	if (options.yes) {
		const body: Record<string, unknown> = {};
		if (options.name !== undefined) body.name = options.name;
		if (options.identifier !== undefined) body.identifier = options.identifier;
		try {
			await client.updateProject(project.id, body);
		} catch (error) {
			if (
				error instanceof PlaneApiError &&
				(error.status === 400 || error.status === 409) &&
				options.identifier !== undefined
			) {
				throw new ReplicateError(
					`Could not rename project identifier to "${options.identifier}": it is invalid or already in use (${error.message})`,
				);
			}
			throw error;
		}
	}
	return {
		dryRun: !options.yes,
		projectId: project.id,
		current: { name: project.name, identifier: project.identifier },
		proposed,
		identifierChanged: proposed.identifier !== project.identifier,
	};
}

function handleError(error: unknown): never {
	if (
		error instanceof ConfigError ||
		error instanceof PlaneApiError ||
		error instanceof ReplicateError
	) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
	}
	process.exit(1);
}

export function registerRenameProjectCommand(program: Command): void {
	program
		.command("rename-project")
		.description("Rename one Plane project (dry-run by default)")
		.requiredOption("--project <identifier-or-name>", "Project identifier or exact name")
		.option("--context <ctx>", "Named Plane context")
		.option("-c, --config <path>", "Config file path")
		.option("--name <name>", "New project name")
		.option("--identifier <identifier>", "New project identifier (changes item prefixes)")
		.option("--yes", "Apply the rename (default: dry-run)")
		.action(async (options) => {
			try {
				if (options.name === undefined && options.identifier === undefined) {
					throw new ConfigError("rename-project requires at least one of --name or --identifier");
				}
				const config = await loadConfig({ configPath: options.config, context: options.context });
				const client = createPlaneClient({
					apiKey: config.apiKey,
					workspaceSlug: config.workspaceSlug,
					baseUrl: config.baseUrl,
					maxRetries: config.maxRetries,
					dialect: config.dialect,
					requestsPerMinute: config.apiRateLimit,
					rateHeadroom: config.rateHeadroom,
					maxConcurrency: config.maxConcurrency,
				});
				const result = await renameProject(client, {
					project: options.project,
					name: options.name,
					identifier: options.identifier,
					yes: options.yes === true,
				});
				console.log(
					`${result.dryRun ? "Dry run" : "Renamed"}: ${result.current.identifier} / ${result.current.name} -> ${result.proposed.identifier} / ${result.proposed.name}`,
				);
				if (result.identifierChanged) {
					console.log(
						chalk.yellow(
							"WARNING: changing the project identifier changes work-item prefixes workspace-visibly.",
						),
					);
				}
				if (result.dryRun) console.log("Nothing was written. Re-run with --yes to apply.");
			} catch (error) {
				handleError(error);
			}
		});
}
