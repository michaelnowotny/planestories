import chalk from "chalk";
import type { Command } from "commander";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { buildShowItem, renderShowText } from "../../sync/show.ts";
import { type GraphSourceProvenance, resolveGraph } from "../graph_source.ts";
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

function formatProvenance(provenance: GraphSourceProvenance): string {
	if (provenance.kind === "snapshot") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · snapshot taken ${provenance.takenAt}`;
	}
	if (provenance.kind === "cache") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · cached at ${provenance.fetchedAt}`;
	}
	if (provenance.kind === "live") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · live`;
	}
	return `${provenance.project} · file ${provenance.path}`;
}

export function registerShowCommand(program: Command) {
	program
		.command("show")
		.description("Show one work item as a compact board summary (no description body). Read-only.")
		.argument("<identifier>", "Plane work-item identifier (e.g. DATA-123)")
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
		)
		.option(
			"-p, --project <name>",
			"Project the identifier belongs to (defaults to defaultProject)",
		)
		.option("--json", "Emit the same one-item summary as machine-readable JSON", false)
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.option("--refresh", "Re-fetch the live board and atomically replace its local cache", false)
		.option(
			"--stale-ok",
			"Use a matching cache older than 1h, explicitly acknowledging that it is stale",
			false,
		)
		.action(async (identifier: string, options) => {
			try {
				const source = await resolveGraph({
					config: options.config,
					context: options.context,
					project: options.project,
					fromSnapshot: options.fromSnapshot,
					boardCache: options.fromSnapshot
						? undefined
						: {
								refresh: options.refresh === true,
								staleOk: options.staleOk === true,
								writeRequired: options.refresh === true,
							},
					json: options.json === true,
				});
				// `show` does not compute a board-wide dependency figure: all scalar,
				// hierarchy, and criteria fields remain exact when an unrelated relation
				// lookup fails. The relation line/payload carries coverage explicitly, so
				// observed direct relations remain useful without claiming completeness.
				const graph = source.acceptPartialGraph(
					"a one-item summary remains useful when it labels incomplete relation coverage",
				);
				const item = buildShowItem(graph, identifier, source.coverage);

				if (options.json) {
					process.stdout.write(
						`${JSON.stringify({ ...item, provenance: source.provenance }, null, "\t")}\n`,
					);
				} else {
					console.log(renderShowText(item, formatProvenance(source.provenance)));
				}
				if (source.client) reportPacing(source.client);
			} catch (error) {
				handleError(error);
			}
		});
}
