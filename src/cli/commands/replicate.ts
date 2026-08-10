import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.ts";
import { TOOL_VERSION } from "../../constants.ts";
import { ConfigError, PlaneApiError, ReplicateError } from "../../errors.ts";
import { createPlaneClient, type PlaneClient } from "../../plane/client.ts";
import { applySnapshot } from "../../replicate/apply.ts";
import { formatApplyReport, formatSnapshotSummary } from "../../replicate/report.ts";
import { parseSnapshot, serializeSnapshot, takeSnapshot } from "../../replicate/snapshot.ts";
import type { ProjectSnapshot } from "../../replicate/types.ts";

function handleError(error: unknown): never {
	if (
		error instanceof ConfigError ||
		error instanceof PlaneApiError ||
		error instanceof ReplicateError
	) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else if (error instanceof Error) {
		console.error(chalk.red(`Error: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

/**
 * Build a client for one side of the replication. `context` names a config/env
 * context (PLANE_CTX_<NAME>_* vars); omitted = the bare-env default config, so
 * single-instance setups keep working without contexts.
 */
async function clientFor(context: string | undefined, configPath?: string): Promise<PlaneClient> {
	const config = await loadConfig({ configPath, context });
	return createPlaneClient({
		apiKey: config.apiKey,
		workspaceSlug: config.workspaceSlug,
		baseUrl: config.baseUrl,
		maxRetries: config.maxRetries,
	});
}

interface SnapshotFlow {
	client: PlaneClient;
	project: string;
	out: string;
	force: boolean;
	concurrency?: number;
}

async function runSnapshot(flow: SnapshotFlow): Promise<ProjectSnapshot> {
	// A snapshot doubles as a full project backup — never clobber one silently.
	if (existsSync(flow.out) && !flow.force) {
		throw new ReplicateError(
			`Snapshot file already exists: ${flow.out}. ` +
				"Pass --force to overwrite it, or pick a new path (each snapshot is a backup).",
		);
	}
	const snapshot = await takeSnapshot(
		flow.client,
		{ projectName: flow.project },
		{
			toolVersion: TOOL_VERSION,
			concurrency: flow.concurrency,
			onProgress: (message) => console.log(chalk.dim(message)),
		},
	);
	await Bun.write(flow.out, serializeSnapshot(snapshot));
	console.log(formatSnapshotSummary(snapshot));
	console.log(`Snapshot written to ${flow.out}`);
	return snapshot;
}

interface ApplyCliOptions {
	yes?: boolean;
	json?: boolean;
	destName?: string;
	destIdentifier?: string;
	journal?: string;
	limit?: string;
	recreateTarget?: boolean;
	exactIdentifiers?: boolean; // commander's --no-exact-identifiers
	assumeGapsDeleted?: boolean;
	allowSqlFinalize?: boolean;
}

async function runApply(
	client: PlaneClient,
	snapshot: ProjectSnapshot,
	snapshotPath: string,
	options: ApplyCliOptions,
): Promise<void> {
	const journalPath =
		options.journal ?? `${snapshotPath}.apply-${client.workspaceSlug}.journal.jsonl`;
	const limit = options.limit === undefined ? undefined : Number(options.limit);
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
		throw new ReplicateError(`--limit must be a non-negative integer, got "${options.limit}"`);
	}
	const result = await applySnapshot(client, snapshot, {
		yes: options.yes === true,
		destName: options.destName,
		destIdentifier: options.destIdentifier,
		flags: {
			allowSqlFinalize: options.allowSqlFinalize === true,
			noExactIdentifiers: options.exactIdentifiers === false,
			assumeGapsDeleted: options.assumeGapsDeleted === true,
			recreateTarget: options.recreateTarget === true,
		},
		journalPath,
		limit,
		onProgress: options.json ? undefined : (message) => console.log(chalk.dim(message)),
		toolVersion: TOOL_VERSION,
	});
	console.log(formatApplyReport(result, { json: options.json === true }));
	if (!options.json) {
		if (result.dryRun) {
			console.log(chalk.yellow("\nDry run — nothing was written. Re-run with --yes to apply."));
		} else if (!result.complete) {
			console.log(chalk.yellow(`\nPaused (resumable). Journal: ${journalPath}`));
		}
	}
}

const CONTEXT_HELP =
	"Named context (config-file entry, or env-only via PLANE_CTX_<NAME>_* vars); omit for the bare PLANE_* environment";

export function registerReplicateCommand(program: Command) {
	const replicate = program
		.command("replicate")
		.description(
			"Migrate a Plane project between instances with exact PROJECT-N preservation " +
				"(one-shot: snapshot the source, then apply to the target)",
		)
		.option("-c, --config <path>", "Config file path")
		.option("--from <context>", `Source: ${CONTEXT_HELP}`)
		.option("--to <context>", `Target: ${CONTEXT_HELP}`)
		.option("-p, --project <name>", "Source project name or identifier")
		.option("-o, --out <file>", "Snapshot file path (default: <IDENTIFIER>.snapshot.json)")
		.option("--force", "Overwrite an existing snapshot file")
		.option("--concurrency <n>", "Paced read concurrency (default 4)")
		.option("--yes", "Actually write to the target (default: dry-run after the snapshot)")
		.option("--json", "Machine-readable apply report")
		.option("--dest-name <name>", "Destination project name (default: the source's)")
		.option("--dest-identifier <id>", "Destination project identifier (changes item PREFIXES)")
		.option("--journal <path>", "Apply journal path (default: derived from the snapshot path)")
		.option("--limit <n>", "Pause after N item creates (resumable)")
		.option("--recreate-target", "Drop the run-created target project and start over")
		.option("--no-exact-identifiers", "Accept renumbering instead of exact PROJECT-N")
		.option(
			"--assume-gaps-deleted",
			"Treat sequence gaps as deletions when archived inventory is unavailable",
		)
		.option(
			"--allow-sql-finalize",
			"Reserved: SQL-assisted exactness (not implemented; fails closed)",
		)
		.action(async (options: ApplyCliOptions & Record<string, string | boolean | undefined>) => {
			try {
				if (!options.from || !options.to) {
					throw new ConfigError(
						"replicate needs --from <context> and --to <context> (or use the snapshot/apply subcommands)",
					);
				}
				if (!options.project) {
					throw new ConfigError("replicate needs --project <name>");
				}
				const source = await clientFor(String(options.from), options.config as string);
				const target = await clientFor(String(options.to), options.config as string);
				if (source.baseUrl === target.baseUrl && source.workspaceSlug === target.workspaceSlug) {
					throw new ReplicateError(
						"Source and target resolve to the same workspace — refusing to replicate onto the source.",
					);
				}
				const snapshot = await takeSnapshotForOneShot(source, options);
				const out = String(options.out ?? defaultSnapshotPath(snapshot));
				await runApply(target, snapshot, out, options);
			} catch (error) {
				handleError(error);
			}
		});

	replicate
		.command("snapshot")
		.description("Read one project completely into a self-contained snapshot file (also a backup)")
		.option("-c, --config <path>", "Config file path")
		.option("--from <context>", `Source: ${CONTEXT_HELP}`)
		.option("-p, --project <name>", "Source project name or identifier")
		.requiredOption("-o, --out <file>", "Snapshot file path")
		.option("--force", "Overwrite an existing snapshot file")
		.option("--concurrency <n>", "Paced read concurrency (default 4)")
		.action(async (options) => {
			try {
				if (!options.project) throw new ConfigError("snapshot needs --project <name>");
				const client = await clientFor(options.from, options.config);
				await runSnapshot({
					client,
					project: options.project,
					out: options.out,
					force: options.force === true,
					concurrency: parseConcurrency(options.concurrency),
				});
			} catch (error) {
				handleError(error);
			}
		});

	replicate
		.command("apply")
		.description("Run the phased writer from a snapshot file (zero source reads; dry-run default)")
		.option("-c, --config <path>", "Config file path")
		.option("--to <context>", `Target: ${CONTEXT_HELP}`)
		.requiredOption("--snapshot <file>", "Snapshot file produced by `replicate snapshot`")
		.option("--yes", "Actually write to the target (default: dry-run)")
		.option("--json", "Machine-readable apply report")
		.option("--dest-name <name>", "Destination project name (default: the source's)")
		.option("--dest-identifier <id>", "Destination project identifier (changes item PREFIXES)")
		.option("--journal <path>", "Apply journal path (default: derived from the snapshot path)")
		.option("--limit <n>", "Pause after N item creates (resumable)")
		.option("--recreate-target", "Drop the run-created target project and start over")
		.option("--no-exact-identifiers", "Accept renumbering instead of exact PROJECT-N")
		.option(
			"--assume-gaps-deleted",
			"Treat sequence gaps as deletions when archived inventory is unavailable",
		)
		.option(
			"--allow-sql-finalize",
			"Reserved: SQL-assisted exactness (not implemented; fails closed)",
		)
		.action(
			async (options: ApplyCliOptions & { snapshot: string; to?: string; config?: string }) => {
				try {
					const client = await clientFor(options.to, options.config);
					const file = Bun.file(options.snapshot);
					if (!(await file.exists())) {
						throw new ReplicateError(`Snapshot file not found: ${options.snapshot}`);
					}
					const snapshot = parseSnapshot(await file.text());
					await runApply(client, snapshot, options.snapshot, options);
				} catch (error) {
					handleError(error);
				}
			},
		);
}

async function takeSnapshotForOneShot(
	source: PlaneClient,
	options: ApplyCliOptions & Record<string, string | boolean | undefined>,
): Promise<ProjectSnapshot> {
	// The one-shot persists its snapshot BEFORE applying: if apply dies, the
	// expensive read is banked and `replicate apply` resumes from the file.
	// An explicit -o collision is checked BEFORE the read — burning the whole
	// paced source read on a file-exists error is the pain this feature removes.
	const explicitOut = options.out ? String(options.out) : null;
	if (explicitOut && existsSync(explicitOut) && options.force !== true) {
		throw new ReplicateError(
			`Snapshot file already exists: ${explicitOut}. Pass --force to overwrite, or -o for a new path.`,
		);
	}
	const snapshot = await takeSnapshot(
		source,
		{ projectName: String(options.project) },
		{
			toolVersion: TOOL_VERSION,
			concurrency: parseConcurrency(options.concurrency as string | undefined),
			onProgress: (message) => console.log(chalk.dim(message)),
		},
	);
	const out = explicitOut ?? defaultSnapshotPath(snapshot);
	if (existsSync(out) && options.force !== true) {
		throw new ReplicateError(
			`Snapshot file already exists: ${out}. Pass --force to overwrite, or -o for a new path.`,
		);
	}
	await Bun.write(out, serializeSnapshot(snapshot));
	console.log(formatSnapshotSummary(snapshot));
	console.log(`Snapshot written to ${out}`);
	return snapshot;
}

function defaultSnapshotPath(snapshot: ProjectSnapshot): string {
	return `${snapshot.project.identifier.toLowerCase() || "project"}.snapshot.json`;
}

function parseConcurrency(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) {
		throw new ReplicateError(`--concurrency must be a positive integer, got "${raw}"`);
	}
	return n;
}
