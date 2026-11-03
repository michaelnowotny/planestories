import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { loadConfig } from "../../config/loader.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import type { PlaneClient } from "../../plane/client.ts";
import {
	type AuditReport,
	auditWrites,
	buildAuditReport,
	formatAuditReport,
	parseAuditWindow,
} from "../../sync/audit.ts";
import {
	findStaleStateCandidates,
	formatStaleStateReport,
	type StaleStateReport,
} from "../../sync/stale_state.ts";
import { announceTarget } from "../announce_target.ts";
import { normalizeBoardBaseUrl } from "../board_cache.ts";
import { COMMENTS_NOT_CAPTURED } from "../comments.ts";
import { type GraphSourceRuntime, resolveGraph } from "../graph_source.ts";
import { cacheReadLine } from "../local_board.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import { connectTarget } from "../target_client.ts";

export interface AuditCommandOptions {
	config?: string;
	context?: string;
	project?: string;
	since?: string;
	json?: boolean;
	/** Refusal text composed from this command's own registered routes. */
	selectProjectHelp?: string;
}

export interface AuditCommandRuntime {
	now?: () => Date;
	graphSource?: GraphSourceRuntime;
	resolveGraph?: typeof resolveGraph;
	loadConfig?: typeof loadConfig;
	connectTarget?: typeof connectTarget;
	announceTarget?: typeof announceTarget;
}

export interface AuditCommandResult {
	report: AuditReport;
	client: PlaneClient;
}

/** No-network-testable orchestration for the cache-local/live-activity split. */
export async function runAudit(
	options: AuditCommandOptions,
	runtime: AuditCommandRuntime = {},
): Promise<AuditCommandResult> {
	const now = (runtime.now ?? (() => new Date()))();
	const window = parseAuditWindow(options.since, now);
	const source = await (runtime.resolveGraph ?? resolveGraph)(
		{
			config: options.config,
			context: options.context,
			project: options.project,
			boardCache: { readRequired: true },
			dependencies: false,
			json: options.json === true,
			selectProjectHelp: options.selectProjectHelp,
		},
		{ ...runtime.graphSource, now: () => now },
	);
	const graph = source.acceptPartialGraph(
		"audit uses cached item timestamps and does not inspect dependency edges",
	);
	if (source.provenance.kind !== "cache") {
		throw new ConfigError("Audit requires the local board cache as its bounded item source.");
	}
	const cachedItems = source.requireCachedWorkItems("audit's bounded activity candidate list");
	if (graph.project !== source.provenance.project) {
		throw new ConfigError("Cached graph/project provenance disagrees; refresh the board cache.");
	}

	const loaded = await (runtime.loadConfig ?? loadConfig)({
		configPath: options.config,
		context: options.context,
	});
	const target = await (runtime.connectTarget ?? connectTarget)(loaded, {
		project: source.provenance.project,
	});
	if (
		normalizeBoardBaseUrl(target.config.baseUrl) !==
			normalizeBoardBaseUrl(source.provenance.baseUrl) ||
		target.config.workspaceSlug !== source.provenance.workspaceSlug
	) {
		throw new ConfigError(
			"The live activity client no longer matches the cache's instance/workspace. Run board fetch for the selected context, then retry audit.",
		);
	}
	(runtime.announceTarget ?? announceTarget)(
		target.config,
		options.context,
		source.provenance.project,
	);

	const scan = await auditWrites(target.client, source.provenance.projectId, cachedItems, window);
	const cacheAgeMs = Math.max(0, now.getTime() - Date.parse(source.provenance.fetchedAt));
	return {
		report: buildAuditReport(scan, {
			instance: source.provenance.baseUrl,
			workspaceSlug: source.provenance.workspaceSlug,
			project: source.provenance.project,
			projectId: source.provenance.projectId,
			cacheFetchedAt: source.provenance.fetchedAt,
			cacheAgeMs,
		}),
		client: target.client,
	};
}

/**
 * Offline check. Comment creation on the CE board we measured bumps
 * `updated_at`, so this does not claim to catch comment-only audit misses.
 * It only lists open items whose latest comment uses closed language.
 */
async function runStaleStateCheck(options: AuditCommandOptions): Promise<StaleStateReport> {
	const now = new Date();
	const source = await resolveGraph({
		config: options.config,
		context: options.context,
		project: options.project,
		boardCache: { readRequired: true },
		dependencies: false,
		json: options.json === true,
		selectProjectHelp: options.selectProjectHelp,
	});
	if (source.provenance.kind !== "cache") {
		throw new ConfigError("The stale-state check reads the local board cache.");
	}
	if (!source.commentCapture) {
		throw new ConfigError(COMMENTS_NOT_CAPTURED);
	}
	const graph = source.acceptPartialGraph(
		"open state comes from the cached graph; dependency edges are not used",
	);
	let since: string | undefined;
	let bounds: { sinceMs: number; throughMs: number } | undefined;
	if (typeof options.since === "string" && options.since.length > 0) {
		const window = parseAuditWindow(options.since, now);
		since = window.since;
		bounds = { sinceMs: Date.parse(window.since), throughMs: Date.parse(window.through) };
	}
	const report: StaleStateReport = {
		heuristic: true,
		fetchedAt: source.provenance.fetchedAt,
		...(since !== undefined ? { since } : {}),
		candidates: findStaleStateCandidates(graph, source.commentCapture.byId, bounds),
	};
	console.error(cacheReadLine(source.provenance.fetchedAt));
	return report;
}

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
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

export function registerAuditCommand(program: Command): void {
	program
		.command("audit")
		.description(
			"Show recent writes attributed to this API key's owner, stamped with their Plane instance",
		)
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option("-p, --project <name>", "Project whose cached board bounds the audit")
		.option(
			"--since <duration|iso>",
			"Bound the audit window (e.g. 90m, 24h, 7d, or an ISO-8601 instant; default 24h)",
		)
		.option("--json", "Emit the same bounded audit report as machine-readable JSON", false)
		.option(
			"--stale-state",
			"List open items whose latest cached comment looks finished. A heuristic, from board fetch --with-comments. Does not walk live activity.",
			false,
		)
		.action(async (options, command: Command) => {
			try {
				if (options.staleState === true) {
					const report = await runStaleStateCheck({
						config: options.config,
						context: options.context,
						project: options.project,
						since: options.since,
						json: options.json === true,
						selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
					});
					process.stdout.write(
						options.json
							? `${JSON.stringify(report, null, "\t")}\n`
							: `${formatStaleStateReport(report)}\n`,
					);
					return;
				}
				const result = await runAudit({
					config: options.config,
					context: options.context,
					project: options.project,
					since: options.since,
					json: options.json === true,
					selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
				});
				process.stdout.write(
					options.json
						? `${JSON.stringify(result.report, null, "\t")}\n`
						: `${formatAuditReport(result.report)}\n`,
				);
				reportPacing(result.client);
			} catch (error) {
				handleError(error);
			}
		});
}
