import chalk from "chalk";
import type { Command } from "commander";
import type { AtlasGraph } from "../../atlas/model.ts";
import { ConfigError, ParseError, PlaneApiError, ResolverError } from "../../errors.ts";
import {
	type GraphQueryAnswerRoutes,
	type GraphQueryRef,
	type GraphQueryReport,
	queryAbandoned,
	queryBlocked,
	queryInconsistent,
	queryOrphans,
	queryReady,
} from "../../sync/graph_queries.ts";
import { formatGraphSourceProvenance } from "../graph_provenance.ts";
import {
	type GraphSourceOptions,
	type GraphSourceResult,
	IncompleteGraphError,
	resolveGraph,
} from "../graph_source.ts";
import { reportPacing } from "../pacing.ts";
import { describeProjectSelection, selectProjectRefusal } from "../project_selection.ts";
import { FROM_SNAPSHOT_HELP } from "../snapshot_option.ts";

export type GraphQueryKind = "ready" | "inconsistent" | "blocked" | "orphans" | "abandoned";

export interface GraphQueryCommandOptions {
	config?: string;
	context?: string;
	project?: string;
	fromSnapshot?: string;
	refresh?: boolean;
	staleOk?: boolean;
	epic?: string;
	limit?: string | number;
	json?: boolean;
	/** Refusal text composed from this command's own registered routes. */
	selectProjectHelp?: string;
}

export interface GraphQueryCommandRuntime {
	resolveGraph?: (options: GraphSourceOptions) => Promise<GraphSourceResult>;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

function handleError(error: unknown): void {
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
	process.exitCode = 1;
}

function purpose(kind: GraphQueryKind): string {
	switch (kind) {
		case "ready":
			return "ready work";
		case "inconsistent":
			return "board consistency";
		case "blocked":
			return "blocked work";
		case "orphans":
			return "dependency orphans";
		case "abandoned":
			return "abandoned work";
	}
}

function parseLimit(value: string | number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ConfigError(`--limit must be a positive integer, got "${String(value)}".`);
	}
	return parsed;
}

function validateLocalOptions(kind: GraphQueryKind, options: GraphQueryCommandOptions): void {
	if (kind === "ready") parseLimit(options.limit);
	if (options.epic !== undefined && options.epic.trim().length === 0) {
		throw new ConfigError("--epic must not be blank; pass an epic identifier or omit the option.");
	}
	if (options.fromSnapshot && (options.refresh || options.staleOk)) {
		throw new ConfigError(
			"--refresh/--stale-ok apply to the board cache and cannot be combined with --from-snapshot.",
		);
	}
}

function shellArg(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sourceArguments(options: GraphQueryCommandOptions): string {
	const args: string[] = [];
	if (options.config) args.push("--config", shellArg(options.config));
	if (options.context) args.push("--context", shellArg(options.context));
	if (options.project) args.push("--project", shellArg(options.project));
	if (options.fromSnapshot) args.push("--from-snapshot", shellArg(options.fromSnapshot));
	if (options.staleOk) args.push("--stale-ok");
	return args.length > 0 ? ` ${args.join(" ")}` : "";
}

function answerRoutes(options: GraphQueryCommandOptions): GraphQueryAnswerRoutes {
	const source = sourceArguments(options);
	return {
		listEpicIdentifiers: `planestories ls --json${source} | jq -r '.availableEpics[].identifier'`,
		showItem: (identifier) => `planestories show ${shellArg(identifier)}${source}`,
	};
}

function retryCommand(
	kind: GraphQueryKind,
	options: GraphQueryCommandOptions,
	source: GraphSourceResult,
): string {
	const parts = [`planestories ${kind} --refresh`];
	if (options.config) parts.push(`--config ${shellArg(options.config)}`);
	if (options.context) parts.push(`--context ${shellArg(options.context)}`);
	parts.push(`--project ${shellArg(options.project ?? source.provenance.project)}`);
	if (options.epic) parts.push(`--epic ${shellArg(options.epic)}`);
	if (options.limit !== undefined) parts.push(`--limit ${shellArg(String(options.limit))}`);
	return parts.join(" ");
}

function snapshotCommand(kind: GraphQueryKind, options: GraphQueryCommandOptions): string {
	const parts = [`planestories ${kind} --from-snapshot <file>`];
	if (options.epic) parts.push(`--epic ${shellArg(options.epic)}`);
	if (options.limit !== undefined) parts.push(`--limit ${shellArg(String(options.limit))}`);
	return parts.join(" ");
}

function id(ref: GraphQueryRef): string {
	return ref.identifier ?? "(unlinked)";
}

function status(ref: GraphQueryRef): string {
	return ref.status ?? "unknown status";
}

function itemLine(ref: GraphQueryRef): string {
	return `${id(ref)} — ${ref.title} [${status(ref)}]`;
}

function counterpartLine(refs: GraphQueryRef[], empty: string): string {
	return refs.length === 0 ? empty : refs.map(itemLine).join("; ");
}

function scopeSuffix(scope: GraphQueryRef | null): string {
	return scope ? ` under ${id(scope)} — ${scope.title}` : "";
}

function unknownStatusNote(count: number): string[] {
	return count === 0
		? []
		: [
				chalk.yellow(
					`  ${count} item(s) omitted from status-dependent predicates because their status group is unknown.`,
				),
			];
}

export function renderGraphQuery(report: GraphQueryReport): string {
	const lines: string[] = [];
	switch (report.kind) {
		case "ready": {
			if (report.items.length === 0) {
				lines.push(
					`No ready items found among ${report.openConsidered} open item(s)${scopeSuffix(report.scope)}.`,
				);
			} else {
				const shown =
					report.items.length === report.matched
						? `${report.matched}`
						: `${report.items.length} of ${report.matched}`;
				lines.push(
					`Ready: ${shown} item(s) from ${report.openConsidered} open${scopeSuffix(report.scope)}`,
				);
				for (const entry of report.items) {
					lines.push(`  ${itemLine(entry.item)} · unblocks ${entry.unblocks.length} item(s)`);
					lines.push(`    blockers: ${counterpartLine(entry.blockers, "none (no prerequisite)")}`);
					lines.push(`    unblocks: ${counterpartLine(entry.unblocks, "none directly")}`);
				}
			}
			lines.push(...unknownStatusNote(report.unknownStatus));
			break;
		}
		case "inconsistent": {
			lines.push(
				`Dependency consistency${scopeSuffix(report.scope)} · ${report.considered} item(s) considered`,
			);
			lines.push(`Done with unfinished blockers (${report.doneWithUnfinishedBlockers.length}):`);
			if (report.doneWithUnfinishedBlockers.length === 0) lines.push("  none");
			for (const entry of report.doneWithUnfinishedBlockers) {
				lines.push(`  ${itemLine(entry.item)}`);
				lines.push(`    unfinished blockers: ${counterpartLine(entry.blockers, "none")}`);
			}
			lines.push(`Ready but not started (${report.notStartedWithDoneBlockers.length}):`);
			if (report.notStartedWithDoneBlockers.length === 0) lines.push("  none");
			for (const entry of report.notStartedWithDoneBlockers) {
				lines.push(`  ${itemLine(entry.item)}`);
				lines.push(`    closed blockers: ${counterpartLine(entry.blockers, "none")}`);
			}
			lines.push(...unknownStatusNote(report.unknownStatus));
			break;
		}
		case "blocked": {
			lines.push(
				`Blocked: ${report.items.length} of ${report.openConsidered} open item(s)${scopeSuffix(report.scope)}`,
			);
			if (report.items.length === 0) lines.push("  none");
			for (const entry of report.items) {
				lines.push(`  ${itemLine(entry.item)}`);
				lines.push(`    unfinished blockers: ${counterpartLine(entry.blockers, "none")}`);
			}
			lines.push(...unknownStatusNote(report.unknownStatus));
			break;
		}
		case "orphans": {
			lines.push(
				`Dependency orphans: ${report.items.length} of ${report.considered} item(s) block nothing and are blocked by nothing`,
			);
			if (report.items.length === 0) lines.push("  none");
			for (const entry of report.items) lines.push(`  ${itemLine(entry.item)}`);
			break;
		}
		case "abandoned": {
			lines.push(
				`Abandoned-parent work: ${report.items.length} of ${report.openConsidered} open item(s)`,
			);
			if (report.items.length === 0) lines.push("  none");
			for (const entry of report.items) {
				lines.push(`  ${itemLine(entry.item)}`);
				lines.push(`    abandoned epic: ${itemLine(entry.parent)}`);
			}
			lines.push(...unknownStatusNote(report.unknownStatus));
			break;
		}
	}
	return lines.join("\n");
}

function buildReport(
	kind: GraphQueryKind,
	graph: AtlasGraph,
	options: GraphQueryCommandOptions,
): GraphQueryReport {
	const routes = answerRoutes(options);
	switch (kind) {
		case "ready":
			return queryReady(graph, { epic: options.epic, limit: parseLimit(options.limit) }, routes);
		case "inconsistent":
			return queryInconsistent(graph, { epic: options.epic }, routes);
		case "blocked":
			return queryBlocked(graph, { epic: options.epic }, routes);
		case "orphans":
			return queryOrphans(graph);
		case "abandoned":
			return queryAbandoned(graph);
	}
}

/** Injectable action so incomplete relation coverage is refusal-tested without a network. */
export async function runGraphQueryCommand(
	kind: GraphQueryKind,
	options: GraphQueryCommandOptions,
	runtime: GraphQueryCommandRuntime = {},
): Promise<boolean> {
	validateLocalOptions(kind, options);
	const resolve = runtime.resolveGraph ?? resolveGraph;
	const stdout = runtime.stdout ?? ((message: string) => console.log(message));
	const stderr = runtime.stderr ?? ((message: string) => console.error(message));
	const source = await resolve({
		config: options.config,
		context: options.context,
		project: options.project,
		fromSnapshot: options.fromSnapshot,
		boardCache: options.fromSnapshot
			? undefined
			: {
					refresh: options.refresh === true,
					staleOk: options.staleOk === true,
				},
		dependencies: true,
		json: options.json === true,
		selectProjectHelp: options.selectProjectHelp,
	});

	let graph: AtlasGraph;
	try {
		graph = source.requireCompleteGraph(purpose(kind));
	} catch (error) {
		if (!(error instanceof IncompleteGraphError)) throw error;
		stderr(chalk.red(error.message));
		stderr(
			chalk.dim(
				`  What would answer it: a complete sweep from \`${retryCommand(kind, options, source)}\`,`,
			),
		);
		stderr(
			chalk.dim(`  or \`${snapshotCommand(kind, options)}\` against a complete recorded graph.`),
		);
		stderr(chalk.dim(`  Source: ${formatGraphSourceProvenance(source.provenance)}`));
		if (source.client) reportPacing(source.client);
		return false;
	}

	const report = buildReport(kind, graph, options);
	// Provenance travels INSIDE the payload in --json mode: stdout stays a single
	// parseable document, and the answer still cannot be quoted without knowing
	// which board and how old. The refusal path above prints nothing to stdout in
	// either mode, so `| jq` sees an empty document and a non-zero exit rather
	// than a half-answer.
	stdout(
		options.json
			? JSON.stringify({ ...report, provenance: source.provenance }, null, "\t")
			: `${renderGraphQuery(report)}\nSource: ${formatGraphSourceProvenance(source.provenance)}`,
	);
	if (source.client) reportPacing(source.client);
	return true;
}

function addSourceOptions(command: Command): Command {
	return command
		.option("-c, --config <path>", "Config file path")
		.option(
			"--context <name>",
			"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars)",
		)
		.option("-p, --project <name>", "Project to query (defaults to defaultProject)")
		.option("--from-snapshot <file>", FROM_SNAPSHOT_HELP)
		.option("--refresh", "Re-fetch live and replace the complete local board cache", false)
		.option("--json", "Emit the same answer as machine-readable JSON", false)
		.option(
			"--stale-ok",
			"Use a matching cache older than 1h, explicitly acknowledging that it is stale",
			false,
		);
}

function action(
	kind: GraphQueryKind,
): (options: GraphQueryCommandOptions, command: Command) => Promise<void> {
	return async (options, command) => {
		try {
			// The refusal must name only what THIS verb registers: none of these
			// take a stories-file argument.
			const withHelp = {
				...options,
				json: options.json === true,
				selectProjectHelp: selectProjectRefusal(describeProjectSelection(command)),
			};
			if (!(await runGraphQueryCommand(kind, withHelp))) process.exitCode = 1;
		} catch (error) {
			handleError(error);
		}
	};
}

export function registerGraphQueryCommands(program: Command): void {
	addSourceOptions(
		program
			.command("ready")
			.description("Open work whose blockers are all closed, ranked by what it unblocks")
			.option("--epic <identifier>", "Restrict candidates to one epic's descendant leaves")
			.option("--limit <n>", "Show at most N ready items after leverage ranking"),
	).action(action("ready"));

	addSourceOptions(
		program
			.command("inconsistent")
			.description("Find Done work with unfinished blockers, plus ready work not started")
			.option("--epic <identifier>", "Restrict candidates to one epic's descendant leaves"),
	).action(action("inconsistent"));

	addSourceOptions(
		program
			.command("blocked")
			.description("Open work with at least one unfinished blocker")
			.option("--epic <identifier>", "Restrict candidates to one epic's descendant leaves"),
	).action(action("blocked"));

	addSourceOptions(
		program
			.command("orphans")
			.description("Leaf stories outside the blocking graph; never age-ranked"),
	).action(action("orphans"));

	addSourceOptions(
		program
			.command("abandoned")
			.description("Open leaf work beneath a cancelled or abandoned epic"),
	).action(action("abandoned"));
}
