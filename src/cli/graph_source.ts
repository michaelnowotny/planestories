import chalk from "chalk";
import { type AtlasGraph, buildAtlasFromBoard, buildAtlasFromFile } from "../atlas/model.ts";
import { fetchRelationsWithSweep } from "../atlas/relations.ts";
import { loadConfig } from "../config/loader.ts";
import { ConfigError } from "../errors.ts";
import { createPlaneClient, type PlaneClient, type PlaneIssueRelations } from "../plane/client.ts";
import { fetchProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import { isCriterionChild } from "../sync/board-story.ts";
import {
	announceSnapshotSource,
	asClient,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "./snapshot_option.ts";

export interface GraphSourceOptions {
	/** A markdown stories file — offline, no config, no API. */
	file?: string;
	config?: string;
	context?: string;
	project?: string;
	fromSnapshot?: string;
	/** False skips the relation sweep (hierarchy only). */
	dependencies?: boolean;
	/** True keeps stdout machine-clean; provenance goes to stderr. */
	json?: boolean;
}

export interface GraphSourceResult {
	graph: AtlasGraph;
	/** The client used, when one was — for `reportPacing`. Absent offline. */
	client?: PlaneClient;
}

/**
 * Build an `AtlasGraph` from a stories file, a live board, or a snapshot.
 *
 * Extracted from the `atlas` command so every graph consumer shares ONE
 * construction path. The alternative — each command assembling its own — is the
 * shape that produced the relation-ref defect, where five call sites did the
 * same job and one of them did it differently (docs/HANDOFF.md §9.5e). A second
 * builder here would be free to drift in exactly the same way.
 */
export async function resolveGraph(options: GraphSourceOptions): Promise<GraphSourceResult> {
	if (options.file) {
		const content = await Bun.file(options.file).text();
		return { graph: buildAtlasFromFile(content, options.file) };
	}

	const config = options.fromSnapshot
		? await loadConfigForSnapshot(options.config, options.context)
		: await loadConfig({ configPath: options.config, context: options.context });
	const snapshotSource = options.fromSnapshot
		? await openSnapshotSource(String(options.fromSnapshot))
		: null;
	if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);

	const projectName = options.project ?? snapshotSource?.projectName ?? config.defaultProject;
	if (!projectName) {
		throw new ConfigError(
			"Provide a <file> argument, or --project <name> (or a defaultProject) to read the live board.",
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

	const resolver = new Resolver(client);
	const project = await resolver.resolveProject(projectName);
	const index = await fetchProjectIndex(client, project.id, project.identifier);

	// Dependency edges need each non-criterion item's relations (one GET each).
	// A per-item failure DROPS that item's edges rather than aborting: for a
	// read-only view a graph with most edges beats no graph. Callers that cannot
	// tolerate a missing edge must say so — see the note in the critical-path
	// command, where a dropped edge could silently shorten the reported floor.
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

	return {
		graph: buildAtlasFromBoard(
			client,
			project.id,
			project.identifier,
			projectName,
			index,
			relationsById,
		),
		client,
	};
}
