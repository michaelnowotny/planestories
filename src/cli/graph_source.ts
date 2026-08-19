import chalk from "chalk";
import {
	type AtlasGraph,
	buildAtlasFromBoard,
	buildAtlasFromFile,
	type DependencyCoverage,
} from "../atlas/model.ts";
import { fetchRelationsWithSweep } from "../atlas/relations.ts";
import { loadConfig } from "../config/loader.ts";
import { ConfigError } from "../errors.ts";
import { createPlaneClient, type PlaneClient, type PlaneIssueRelations } from "../plane/client.ts";
import { fetchProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import { isCriterionChild } from "../sync/board-story.ts";
import { announceTarget } from "./announce_target.ts";
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

/** Thrown by `requireCompleteGraph`. Carries the coverage so callers can explain it. */
export class IncompleteGraphError extends Error {
	constructor(
		readonly coverage: DependencyCoverage,
		readonly purpose: string,
	) {
		super(
			coverage.kind === "skipped"
				? `Refusing to compute ${purpose}: dependency relations were not fetched, so the graph has no edges.`
				: `Refusing to compute ${purpose}: ${coverage.kind === "partial" ? coverage.failures : 0} relation lookup(s) failed, so the dependency graph is incomplete.`,
		);
		this.name = "IncompleteGraphError";
	}
}

/**
 * The graph, reachable ONLY through a method that names what the caller is doing
 * with it.
 *
 * There is deliberately no `graph` property. Three review rounds found the same
 * defect — a completeness rule honoured at one call site and forgotten at the
 * next — because the rule lived in a COMMENT and `const { graph } = await
 * resolveGraph(...)` compiled fine without it. `trend` and `diff` both did
 * exactly that. Now that line does not type-check, so the question has to be
 * answered rather than remembered.
 */
export interface GraphSourceResult {
	/** The client used, when one was — for `reportPacing`. Absent offline. */
	client?: PlaneClient;
	coverage: DependencyCoverage;
	/** Lookups recovered by the sequential second pass (informational). */
	relationRecovered: number;
	/**
	 * For anything that computes a FIGURE from the dependency structure. A missing
	 * `blocks` edge silently shortens a schedule floor or hides a cycle that should
	 * have been a refusal, so this throws unless coverage is complete.
	 */
	requireCompleteGraph(purpose: string): AtlasGraph;
	/**
	 * For read-only views that can live with a dropped edge. The `reason` is not
	 * used at runtime — it exists so the choice is visible at the call site and in
	 * review, rather than being the silent default it used to be.
	 */
	acceptPartialGraph(reason: string): AtlasGraph;
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
		// A stories file carries its own `blocks:` lines, so the dependency
		// structure is fully present by construction — nothing was fetched, and
		// nothing was skipped either.
		return graphSourceResult(buildAtlasFromFile(content, options.file), { kind: "complete" }, 0);
	}

	const config = options.fromSnapshot
		? await loadConfigForSnapshot(options.config, options.context)
		: await loadConfig({ configPath: options.config, context: options.context });
	const snapshotSource = options.fromSnapshot
		? await openSnapshotSource(String(options.fromSnapshot))
		: null;
	if (snapshotSource) announceSnapshotSource(snapshotSource, options.json === true);

	const projectName = options.project ?? snapshotSource?.projectName ?? config.defaultProject;
	// Read-only commands say it too: "which board am I looking at" is the first
	// question when a number surprises you.
	if (!snapshotSource) announceTarget(config, options.context, projectName ?? undefined);
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
	let relationFailures = 0;
	let relationRecovered = 0;
	if (options.dependencies !== false) {
		const items = index.items.filter((item) => !isCriterionChild(item));
		const result = await fetchRelationsWithSweep(client, project.id, items);
		relationsById = result.relationsById;
		relationFailures = result.failed;
		relationRecovered = result.recovered;
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

	const coverage: DependencyCoverage =
		options.dependencies === false
			? { kind: "skipped" }
			: relationFailures > 0
				? { kind: "partial", failures: relationFailures }
				: { kind: "complete" };

	return graphSourceResult(
		buildAtlasFromBoard(client, project.id, project.identifier, projectName, index, relationsById),
		coverage,
		relationRecovered,
		client,
	);
}

function graphSourceResult(
	graph: AtlasGraph,
	coverage: DependencyCoverage,
	relationRecovered: number,
	client?: PlaneClient,
): GraphSourceResult {
	return {
		client,
		coverage,
		relationRecovered,
		requireCompleteGraph(purpose: string): AtlasGraph {
			if (coverage.kind !== "complete") throw new IncompleteGraphError(coverage, purpose);
			return graph;
		},
		acceptPartialGraph(_reason: string): AtlasGraph {
			return graph;
		},
	};
}
