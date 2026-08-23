import chalk from "chalk";
import type { Command } from "commander";
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
import { announceTarget } from "../announce_target.ts";
import { normalizeBoardBaseUrl } from "../board_cache.ts";
import { type GraphSourceRuntime, resolveGraph } from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";
import { connectTarget } from "../target_client.ts";

export interface AuditCommandOptions {
	config?: string;
	context?: string;
	since?: string;
	json?: boolean;
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
			boardCache: { readRequired: true },
			dependencies: false,
			json: options.json === true,
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

function handleError(error: unknown): never {
	if (
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
		.option(
			"--since <duration|iso>",
			"Bound the audit window (e.g. 90m, 24h, 7d, or an ISO-8601 instant; default 24h)",
		)
		.option("--json", "Emit the same bounded audit report as machine-readable JSON", false)
		.action(async (options) => {
			try {
				const result = await runAudit({
					config: options.config,
					context: options.context,
					since: options.since,
					json: options.json === true,
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
