import chalk from "chalk";
import type { Command } from "commander";
import { ParentCycleError } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import type { PlaneClient } from "../../plane/client.ts";
import { generatePacket } from "../../sync/packet.ts";
import type { ResolvedConfig } from "../../types.ts";
import { commentAttachment, commentsCaptured, workItemIdFromUrl } from "../comments.ts";
import { openBoardCacheOrLive } from "../local_board.ts";
import { resolveOutputPath } from "../output_path.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import {
	announceSnapshotSource,
	asClient,
	FROM_SNAPSHOT_HELP,
	loadConfigForSnapshot,
	openSnapshotSource,
} from "../snapshot_option.ts";

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

export function registerPacketCommand(program: Command) {
	program
		.command("packet")
		.description(
			"Emit a self-contained implementable brief for a coding agent from a board ticket (an epic emits itself + every descendant, nested epics included). Prints to stdout unless -o is given.",
		)
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
		.option("-o, --output <file>", "Write the packet to a file instead of stdout")
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.option("--refresh", "Re-fetch the live board and atomically replace its local cache", false)
		.option(
			"--stale-ok",
			"Use a matching cache older than 1h, explicitly acknowledging that it is stale",
			false,
		)
		.option(
			"--with-comments",
			"Append comments for the packet's stories. Requires board fetch --with-comments or --from-snapshot.",
			false,
		)
		.action(async (identifier: string, options, command: Command) => {
			try {
				if (options.fromSnapshot && (options.refresh || options.staleOk)) {
					throw new ConfigError(
						"--refresh and --stale-ok apply to the board cache and cannot be combined with --from-snapshot.",
					);
				}
				let client: PlaneClient;
				let resolvedConfig: ResolvedConfig;
				let pacingClient: PlaneClient | undefined;
				let commentProjectId = "";
				if (options.fromSnapshot) {
					const snapshotSource = await openSnapshotSource(String(options.fromSnapshot));
					announceSnapshotSource(snapshotSource, options.json === true);
					resolvedConfig = await loadConfigForSnapshot(options.config, options.context);
					client = asClient(snapshotSource);
				} else {
					const opened = await openBoardCacheOrLive({
						config: options.config,
						context: options.context,
						project: options.project,
						refresh: options.refresh === true,
						staleOk: options.staleOk === true,
						json: options.json === true,
						selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
					});
					client = opened.client;
					resolvedConfig = opened.config;
					pacingClient = opened.pacingClient;
					commentProjectId = opened.cache.project.id;
				}

				const { markdown, packet } = await generatePacket(client, {
					config: resolvedConfig,
					identifier,
					project: options.project,
				});
				const stories = [packet.root, ...packet.children];
				const workItemIds = commentWorkItemIds(
					stories.map((story) => story.url),
					options.withComments === true,
					client,
				);
				const footer = await commentAttachment({
					source: client,
					projectId: commentProjectId,
					workItemIds,
					withComments: options.withComments === true,
				});
				const document = `${markdown.trimEnd()}\n\n${footer}\n`;

				if (options.output) {
					const abs = resolveOutputPath(options.output, `${identifier}.md`); // -o is set here
					await Bun.write(abs, document);
					const childNote =
						packet.kind === "epic" ? ` (epic + ${packet.children.length} child brief(s))` : "";
					console.error(
						chalk.green(`Wrote packet for ${packet.root.identifier}${childNote} → ${abs}`),
					);
				} else {
					// The packet itself goes to stdout so it can be piped to an agent.
					process.stdout.write(document);
				}
				reportPacing(pacingClient ?? client);
			} catch (error) {
				handleError(error);
			}
		});
}

/**
 * Ids for a captured source. When comments were not captured, skip the lookup:
 * a missing id must not turn "not fetched" into a hard error on the default path.
 * When they were captured, a missing id would under-count, so refuse.
 */
function commentWorkItemIds(
	urls: Array<string | null | undefined>,
	withComments: boolean,
	source: object,
): string[] | null {
	if (!commentsCaptured(source)) return null;
	return urls.map((url) => {
		const id = workItemIdFromUrl(url);
		if (!id) {
			throw new ConfigError(
				withComments
					? "Cannot locate a work item id, so its comments cannot be printed."
					: "Cannot locate a work item id, so its comments cannot be counted. Refusing to report them as absent.",
			);
		}
		return id;
	});
}
