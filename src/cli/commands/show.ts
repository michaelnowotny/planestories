import chalk from "chalk";
import type { Command } from "commander";
import type { AtlasGraph } from "../../atlas/model.ts";
import { ParentCycleError } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import { htmlToMarkdown } from "../../markdown/html.ts";
import { buildShowItem, renderShowText } from "../../sync/show.ts";
import {
	COMMENTS_NOT_CAPTURED,
	commentNotShownLine,
	type ReadableComment,
	renderCommentBodies,
	workItemIdForIdentifier,
} from "../comments.ts";
import { formatGraphSourceProvenance } from "../graph_provenance.ts";
import { type GraphSourceResult, resolveGraph } from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import { FROM_SNAPSHOT_HELP } from "../snapshot_option.ts";

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
		console.error(chalk.red(`Error: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
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
		.option(
			"--with-comments",
			"Print this item's comments. Requires board fetch --with-comments or --from-snapshot.",
			false,
		)
		.action(async (identifier: string, options, command: Command) => {
			try {
				const source = await resolveGraph({
					selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
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
				// A "not found" that names only the project is ambiguous when the same
				// project name exists on two instances — which is the exact confusion
				// the Cloud/CE cutover produced. Name where we looked.
				let item: ReturnType<typeof buildShowItem>;
				try {
					item = buildShowItem(graph, identifier, source.coverage);
				} catch (error) {
					if (error instanceof ConfigError) {
						throw new ConfigError(
							`${error.message} Searched ${formatGraphSourceProvenance(source.provenance)}.`,
						);
					}
					throw error;
				}

				const withComments = options.withComments === true;
				const comments = await commentsForShownItem(source, graph, identifier);
				if (withComments && comments === null) throw new ConfigError(COMMENTS_NOT_CAPTURED);
				const note =
					withComments && comments
						? renderCommentBodies(comments)
						: commentNotShownLine(comments === null ? null : comments.length);

				if (options.json) {
					const payload: Record<string, unknown> = { ...item, provenance: source.provenance };
					if (withComments && comments) {
						payload.comments = comments.map((comment) => ({
							id: comment.id,
							createdAt: comment.createdAt,
							createdBy: comment.createdBy,
							text: htmlToMarkdown(comment.commentHtml),
						}));
					} else {
						payload.commentsNote = note;
					}
					process.stdout.write(`${JSON.stringify(payload, null, "\t")}\n`);
				} else {
					console.log(
						`${renderShowText(item, formatGraphSourceProvenance(source.provenance))}\n${note}`,
					);
				}
				if (source.client) reportPacing(source.client);
			} catch (error) {
				handleError(error);
			}
		});
}

/**
 * Comments on the shown work item only. Criterion children folded into the
 * graph are separate items and are not included.
 *
 * Null means the source did not capture comments. An empty array means it did,
 * and this item has none.
 */
async function commentsForShownItem(
	source: GraphSourceResult,
	graph: AtlasGraph,
	identifier: string,
): Promise<ReadableComment[] | null> {
	if (source.provenance.kind === "cache") {
		if (!source.commentCapture) return null;
		const id = workItemIdForIdentifier(graph, identifier);
		if (!id) {
			throw new ConfigError(
				"Cannot locate this work item's id in the board cache, so its comments cannot be read.",
			);
		}
		return [...(source.commentCapture.byId[id] ?? [])];
	}
	if (source.provenance.kind === "snapshot" && source.client) {
		const id = workItemIdForIdentifier(graph, identifier);
		if (!id) {
			throw new ConfigError(
				"Cannot locate this work item's id in the snapshot, so its comments cannot be read.",
			);
		}
		return source.client.listWorkItemComments<ReadableComment>("", id);
	}
	return null;
}
