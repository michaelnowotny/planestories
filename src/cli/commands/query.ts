import chalk from "chalk";
import { type Command, Option } from "commander";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import {
	groupQueryItems,
	type QueryAnswerRoutes,
	type QueryPredicates,
	queryStories,
	renderCountText,
	renderListText,
	validateQueryPredicates,
} from "../../sync/query.ts";
import { shellQuote } from "../../utils/shell.ts";
import { formatGraphSourceProvenance } from "../graph_provenance.ts";
import { IncompleteGraphError, resolveGraph } from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import { FROM_SNAPSHOT_HELP } from "../snapshot_option.ts";

interface QueryCommandOptions {
	config?: string;
	context?: string;
	project?: string;
	fromSnapshot?: string;
	refresh?: boolean;
	staleOk?: boolean;
	json?: boolean;
	open?: boolean;
	status?: string;
	label?: string;
	assignee?: string;
	epic?: string;
	flagged?: boolean;
	/**
	 * Commander stores `--no-estimate` under the UN-prefixed name: absent → true,
	 * passed → false. Reading a `noEstimate` key here made the documented flag a
	 * silent no-op, so `count --no-estimate` printed the unfiltered count.
	 * `import.ts` already spells this mapping out for `--no-write-back`.
	 */
	estimate?: boolean;
	blocked?: boolean;
	groupBy?: "status" | "assignee" | "label" | "epic";
	/** Refusal text composed from this command's own registered routes. */
	selectProjectHelp?: string;
}

function predicates(options: QueryCommandOptions): QueryPredicates {
	return {
		open: options.open === true,
		status: options.status,
		label: options.label,
		assignee: options.assignee,
		epic: options.epic,
		flagged: options.flagged === true,
		noEstimate: options.estimate === false,
		blocked: options.blocked === true,
	};
}

function addQueryOptions(command: Command): Command {
	return (
		command
			.option("-c, --config <path>", "Config file path")
			.option(
				"--context <name>",
				"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars; bare PLANE_* env applies only without --context)",
			)
			.option("-p, --project <name>", "Project to query (defaults to defaultProject)")
			.option("--open", "Only stories not completed or cancelled", false)
			.option("--status <state>", "Only stories with this exact status name (case-insensitive)")
			.option("--label <name>", "Only stories carrying this label (case-insensitive)")
			.option("--assignee <name>", "Only stories assigned to this email/display name")
			.option("--epic <identifier>", "Only leaf stories beneath this epic, including nested epics")
			.option("--flagged", "Only stories with a measured spec-quality finding", false)
			// No default: a `false` default here would make `estimate === false` true on
			// every run, silently turning EVERY ls/count into an unestimated-only query.
			.option("--no-estimate", "Only stories without an **Effort:** estimate")
			.option("--blocked", "Only open stories with at least one unfinished blocker", false)
			.option("--json", "Emit the same answer as machine-readable JSON", false)
			.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
			.option("--refresh", "Re-fetch the live board and atomically replace its local cache", false)
			.option(
				"--stale-ok",
				"Use a matching cache older than 1h, explicitly acknowledging that it is stale",
				false,
			)
	);
}

/** Attach the refusal composed from THIS command's registered routes. */
function withSelectProjectHelp(
	options: QueryCommandOptions,
	command: Command,
): QueryCommandOptions {
	return { ...options, selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)) };
}

async function resolveQuery(options: QueryCommandOptions) {
	const queryPredicates = predicates(options);
	validateQueryPredicates(queryPredicates);
	// A relation sweep is needed only for --blocked, except that --refresh always
	// publishes a complete cache and therefore must fetch relations too.
	const dependencies = options.blocked === true || options.refresh === true;
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
		dependencies,
		json: options.json === true,
		selectProjectHelp: options.selectProjectHelp,
	});
	const graph = options.blocked
		? source.requireCompleteGraph("the --blocked predicate")
		: source.acceptPartialGraph(
				"status, metadata, effort, quality, and hierarchy predicates do not depend on relations",
			);
	return { source, result: queryStories(graph, queryPredicates, answerRoutes(options)) };
}

function sourceArguments(options: QueryCommandOptions): string {
	const args: string[] = [];
	if (options.config) args.push("--config", shellQuote(options.config));
	if (options.context) args.push("--context", shellQuote(options.context));
	if (options.project) args.push("--project", shellQuote(options.project));
	if (options.fromSnapshot) args.push("--from-snapshot", shellQuote(options.fromSnapshot));
	if (options.staleOk) args.push("--stale-ok");
	return args.length > 0 ? ` ${args.join(" ")}` : "";
}

function answerRoutes(options: QueryCommandOptions): QueryAnswerRoutes {
	const source = sourceArguments(options);
	return {
		listEpicIdentifiers: `planestories ls --json${source} | jq -r '.availableEpics[].identifier'`,
		showItem: (identifier) => `planestories show ${shellQuote(identifier)}${source}`,
	};
}

function boardFetchCommand(options: QueryCommandOptions): string {
	const args: string[] = [];
	if (options.config) args.push("--config", shellQuote(options.config));
	if (options.context) args.push("--context", shellQuote(options.context));
	if (options.project) args.push("--project", shellQuote(options.project));
	return `planestories board fetch${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

function handleError(error: unknown, options: QueryCommandOptions): never {
	if (error instanceof IncompleteGraphError) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
		console.error(
			chalk.dim(
				`  Run \`${boardFetchCommand(options)}\` when a complete relation sweep can finish, then retry this query.`,
			),
		);
		console.error(
			chalk.dim(
				"  Or pass --from-snapshot <file> for an already-recorded complete dependency graph.",
			),
		);
	} else if (
		error instanceof ConfigError ||
		error instanceof ParseError ||
		error instanceof PlaneApiError ||
		error instanceof ResolverError
	) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else if (error instanceof Error) {
		console.error(chalk.red(`Error: ${error.message}`));
		if (options.refresh) {
			console.error(
				chalk.dim(
					"  Retry with --refresh when a complete fetch can finish, or omit --refresh to use the previous matching cache if it is still fresh.",
				),
			);
		}
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

export function registerLsCommand(program: Command): void {
	addQueryOptions(
		program
			.command("ls")
			.description(
				"List leaf stories using fixed, AND-composed local board predicates. Read-only.",
			),
	).action(async (options: QueryCommandOptions, command: Command) => {
		try {
			const { source, result } = await resolveQuery(withSelectProjectHelp(options, command));
			if (options.json) {
				process.stdout.write(
					`${JSON.stringify({ ...result, provenance: source.provenance }, null, "\t")}\n`,
				);
			} else {
				console.log(
					`${renderListText(result)}\nSource: ${formatGraphSourceProvenance(source.provenance)}`,
				);
			}
			if (source.client) reportPacing(source.client);
		} catch (error) {
			handleError(error, options);
		}
	});
}

export function registerCountCommand(program: Command): void {
	addQueryOptions(
		program
			.command("count")
			.description("Count leaf stories with an explicit denominator. Read-only."),
	)
		.addOption(
			new Option("--group-by <dimension>", "Break down matches by a fixed dimension").choices([
				"status",
				"assignee",
				"label",
				"epic",
			]),
		)
		.action(async (options: QueryCommandOptions, command: Command) => {
			try {
				const { source, result } = await resolveQuery(withSelectProjectHelp(options, command));
				const groups = options.groupBy ? groupQueryItems(result.items, options.groupBy) : [];
				if (options.json) {
					process.stdout.write(
						`${JSON.stringify(
							{
								count: result.count,
								denominator: result.denominator,
								predicates: result.predicates,
								scopeEpic: result.scopeEpic,
								...(options.groupBy ? { groupBy: options.groupBy, groups } : {}),
								provenance: source.provenance,
							},
							null,
							"\t",
						)}\n`,
					);
				} else {
					console.log(
						`${renderCountText(result, groups, options.groupBy)}\nSource: ${formatGraphSourceProvenance(source.provenance)}`,
					);
				}
				if (source.client) reportPacing(source.client);
			} catch (error) {
				handleError(error, options);
			}
		});
}
