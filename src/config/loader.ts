import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../errors.ts";
import type { PlaneEndpointDialect } from "../plane/client.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_PLANE_BASE_URL } from "../plane/client.ts";
import type { CliConfig, MultiContextConfig, ResolvedConfig } from "../types.ts";
import { assertConfigFile, isMultiContextConfig } from "./schema.ts";

export interface LoadConfigOptions {
	/** Explicit path to a config file (e.g. from --config flag) */
	configPath?: string;
	/** Working directory used for .planestoriesrc.json discovery */
	cwd?: string;
	/** Named context to select from a multi-context config */
	context?: string;
	/**
	 * Skip ONLY the API-key/workspace-slug assertions. Used by the `--from-snapshot`
	 * path, which reads a file and never builds a client, so demanding credentials
	 * there would make an offline feature require secrets. Everything else — file
	 * discovery, shape validation, dialect and rate-limit parsing — still applies and
	 * still throws, so a malformed config or a bad `--config` path is never silently
	 * swallowed.
	 */
	requireCredentials?: boolean;
	/**
	 * False forbids IMPLICIT context selection (`defaultContext`, or being the only
	 * context) — the caller must name one explicitly or run on the bare-env default.
	 *
	 * `replicate` sets this. Its `--from`/`--to` are plain options, and what used to
	 * make them effectively mandatory was that a multi-context config THREW without
	 * them. Adding a default would have quietly removed that: `replicate apply
	 * --snapshot x.json` with no `--to` would write an entire project into whichever
	 * instance the config happened to prefer. A cross-instance migration must never
	 * silently pick a side.
	 */
	allowImplicitContext?: boolean;
}

/**
 * Discovers, reads, validates, and resolves the CLI configuration.
 *
 * Discovery order:
 *   1. `options.configPath` -- explicit --config flag
 *   2. `.planestoriesrc.json` in `options.cwd` (or process.cwd())
 *   3. `~/.config/planestories/config.json`
 *
 * Credential resolution (replicate P1 — per-context isolation):
 *   - DEFAULT (no --context): bare PLANE_API_KEY / PLANE_WORKSPACE_SLUG /
 *     PLANE_BASE_URL env vars override file values, as always.
 *   - NAMED context (--context <name>): ONLY the per-context env vars
 *     PLANE_CTX_<NAME>_API_KEY / _WORKSPACE_SLUG / _BASE_URL override the
 *     context's file entry. Bare PLANE_* is DELIBERATELY ignored — a single
 *     global key must never silently clobber both sides of a --from/--to
 *     instance pair (the dual-profile clobber both review engines flagged).
 *   - ENV-ONLY context: when the config file has no such context (or is flat)
 *     but PLANE_CTX_<NAME>_API_KEY exists, the context is synthesized purely
 *     from its per-context env vars — no config file required.
 *   <NAME> = context name uppercased, runs of non-alphanumerics -> "_".
 * Credentials are expected to come from the environment (.env); committed
 * config files should hold only non-secret defaults. A ConfigError is thrown
 * when no API key or workspace slug is available from any source.
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig> {
	const configPath = resolveConfigPath(options);
	const raw = configPath ? await readConfigFile(configPath) : {};

	// Validate shape (flat or multi-context)
	assertConfigFile(raw);

	// Resolve multi-context → flat CliConfig
	let config: CliConfig;
	// The context ACTUALLY in force — explicit `--context`, or one selected
	// implicitly by `defaultContext` / being the only one. Every per-context
	// lookup below keys off THIS, never off `options.context`: an implicitly
	// selected context must be as isolated from the bare `PLANE_*` env vars as an
	// explicit one, or a cloud key sitting in the environment could silently
	// authenticate a command aimed at CE. That isolation is the whole point of the
	// credential contract, and a convenience default must not become a hole in it.
	let resolvedContext: string | undefined = options?.context;

	if (options?.context !== undefined && normalizeCtx(options.context) === "") {
		throw new ConfigError(
			`Context name "${options.context}" normalizes to nothing (no alphanumerics) — ` +
				"per-context env lookup would be ambiguous. Use a name with letters/digits.",
		);
	}

	if (isMultiContextConfig(raw)) {
		const multiConfig = raw as MultiContextConfig;

		// Two context names that normalize to the same env name (e.g. "a-b" and
		// "a_b" -> PLANE_CTX_A_B_*) would share credential overrides — the exact
		// cross-instance clobber this contract exists to prevent. Reject outright.
		const byNorm = new Map<string, string>();
		for (const c of multiConfig.contexts) {
			const norm = normalizeCtx(c.name);
			if (norm === "") {
				throw new ConfigError(
					`Context name "${c.name}" normalizes to nothing (no alphanumerics) — ` +
						"per-context env lookup would be ambiguous. Rename it.",
				);
			}
			const clash = byNorm.get(norm);
			if (clash !== undefined && clash !== c.name) {
				throw new ConfigError(
					`Context names "${clash}" and "${c.name}" normalize to the same env name ` +
						`(PLANE_CTX_${norm}_*) — rename one; per-context credentials must be unambiguous.`,
				);
			}
			byNorm.set(norm, c.name);
		}

		// Resolution order: explicit --context -> defaultContext -> the ONLY context
		// -> refuse and list the names. A config with one installation should not
		// demand a flag naming the only thing it could possibly mean.
		if (multiConfig.defaultContext !== undefined) {
			const named = multiConfig.contexts.some((c) => c.name === multiConfig.defaultContext);
			if (!named) {
				// Present-but-invalid config fails loudly; a dangling default must never
				// degrade into "use some other context", which would silently point a
				// command at the wrong Plane installation.
				const names = multiConfig.contexts.map((c) => c.name).join(", ");
				throw new ConfigError(
					`defaultContext "${multiConfig.defaultContext}" does not name any context in this config. ` +
						`Available contexts: ${names}.`,
				);
			}
		}
		if (!resolvedContext) {
			const implied =
				multiConfig.defaultContext ??
				(multiConfig.contexts.length === 1 ? multiConfig.contexts[0]?.name : undefined);
			if (implied === undefined) {
				const names = multiConfig.contexts.map((c) => c.name).join(", ");
				throw new ConfigError(
					`Config file contains multiple contexts. Use --context <name> to select one, ` +
						`or set "defaultContext" in the config. Available contexts: ${names}`,
				);
			}
			if (options?.allowImplicitContext === false) {
				throw new ConfigError(
					`This command will not infer an installation. Name it explicitly ` +
						`(e.g. --from/--to ${implied}). Available contexts: ` +
						`${multiConfig.contexts.map((c) => c.name).join(", ")}.`,
				);
			}
			resolvedContext = implied;
		}

		const entry = multiConfig.contexts.find((c) => c.name === resolvedContext);
		if (!entry) {
			// Env-only context: synthesized purely from PLANE_CTX_<NAME>_* vars.
			const wanted = resolvedContext as string;
			if (process.env[ctxEnvName(wanted, "API_KEY")]) {
				config = {};
			} else {
				const names = multiConfig.contexts.map((c) => c.name).join(", ");
				throw new ConfigError(
					`Context "${wanted}" not found. Available contexts: ${names}. ` +
						`(An env-only context needs ${ctxEnvName(wanted, "API_KEY")} set.)`,
				);
			}
		} else {
			config = {
				apiKey: entry.apiKey,
				workspaceSlug: entry.workspaceSlug,
				baseUrl: entry.baseUrl,
				dialect: entry.dialect,
				defaultProject: entry.defaultProject,
				defaultLabels: entry.defaultLabels,
				sourceLabel: entry.sourceLabel,
				apiRateLimit: entry.apiRateLimit,
				maxConcurrency: entry.maxConcurrency,
				rateHeadroom: entry.rateHeadroom,
			};
		}
	} else {
		if (options?.context) {
			// Flat/no config file + a named context: valid ONLY as an env-only context.
			if (process.env[ctxEnvName(options.context, "API_KEY")]) {
				config = {};
			} else {
				throw new ConfigError(
					`Context "${options.context}" was requested but the config file is not ` +
						`multi-context and ${ctxEnvName(options.context, "API_KEY")} is not set. ` +
						"Define the context in the config file or set its PLANE_CTX_* env vars.",
				);
			}
		} else {
			config = raw as CliConfig;
		}
	}

	// Merge env vars. A NAMED context resolves ONLY its per-context vars; the
	// bare PLANE_* vars apply ONLY on the default path (see doc comment above).
	const envFor = (
		field: "API_KEY" | "WORKSPACE_SLUG" | "BASE_URL" | "DIALECT" | "API_RATE_LIMIT",
	): string | undefined =>
		resolvedContext
			? process.env[ctxEnvName(resolvedContext, field)]
			: process.env[`PLANE_${field}`];
	const envApiKey = envFor("API_KEY");
	if (envApiKey) {
		config.apiKey = envApiKey;
	}
	const envSlug = envFor("WORKSPACE_SLUG");
	if (envSlug) {
		config.workspaceSlug = envSlug;
	}
	const envBaseUrl = envFor("BASE_URL");
	if (envBaseUrl) {
		config.baseUrl = envBaseUrl;
	}
	const dialectVariable = resolvedContext
		? ctxEnvName(resolvedContext, "DIALECT")
		: "PLANE_DIALECT";
	const envDialect = envFor("DIALECT");
	if (envDialect !== undefined) {
		config.dialect = parseDialect(envDialect, dialectVariable);
	}
	const rateLimitVariable = resolvedContext
		? ctxEnvName(resolvedContext, "API_RATE_LIMIT")
		: "PLANE_API_RATE_LIMIT";
	const envRateLimit = envFor("API_RATE_LIMIT");
	if (envRateLimit !== undefined) {
		config.apiRateLimit = parseApiRateLimit(envRateLimit, rateLimitVariable);
	}
	if (process.env.PLANE_SOURCE_LABEL) {
		config.sourceLabel = process.env.PLANE_SOURCE_LABEL;
	}

	if (options?.requireCredentials === false) {
		// Credentials are genuinely optional here; everything above has already been
		// validated, so a present config file is fully honoured (defaultProject and
		// friends survive) and only the two secret assertions are skipped. baseUrl is
		// left as the file supplied it — no production default is invented for a path
		// that must never look like a live instance.
		return resolveConfig(config, { allowMissingCredentials: true, contextName: resolvedContext });
	}

	if (!config.apiKey) {
		throw new ConfigError(
			// Keyed on the RESOLVED context, not the flag. An implicitly selected
			// context ignores bare `PLANE_*` by design, so telling the user to set
			// `PLANE_API_KEY` there is advice that cannot work — they would set it,
			// re-run, and get the same error with no hint why.
			resolvedContext
				? `No API key for context "${resolvedContext}". Set ${ctxEnvName(resolvedContext, "API_KEY")} ` +
						"in your environment (.env), or apiKey in that context's config entry."
				: "No API key found. Set PLANE_API_KEY in your environment (.env). " +
						"Do not commit credentials to a config file.",
		);
	}

	if (!config.workspaceSlug) {
		throw new ConfigError(
			resolvedContext
				? `No workspace slug for context "${resolvedContext}". Set ${ctxEnvName(resolvedContext, "WORKSPACE_SLUG")} ` +
						"in your environment (.env), or workspaceSlug in that context's config entry."
				: "No workspace slug found. Set PLANE_WORKSPACE_SLUG in your environment (.env) " +
						'or "workspaceSlug" in your config file (.planestoriesrc.json).',
		);
	}

	return resolveConfig(config, { contextName: resolvedContext });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalized context segment for env lookup (may be "" — callers must reject). */
function normalizeCtx(context: string): string {
	return context
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** Per-context env var name: PLANE_CTX_<NAME>_<FIELD>, name normalized. */
export function ctxEnvName(context: string, field: string): string {
	return `PLANE_CTX_${normalizeCtx(context)}_${field}`;
}

/**
 * Determines which config file path to use based on discovery order.
 * Returns `undefined` when no config file is found (which is okay if
 * PLANE_API_KEY and PLANE_WORKSPACE_SLUG are set in the environment).
 */
function resolveConfigPath(options?: LoadConfigOptions): string | undefined {
	// 1. Explicit path
	if (options?.configPath) {
		if (!existsSync(options.configPath)) {
			throw new ConfigError(`Config file not found: ${options.configPath}`);
		}
		return options.configPath;
	}

	// 2. .planestoriesrc.json in cwd
	const cwd = options?.cwd ?? process.cwd();
	const rcPath = join(cwd, ".planestoriesrc.json");
	if (existsSync(rcPath)) {
		return rcPath;
	}

	// 3. ~/.config/planestories/config.json
	const home = process.env.HOME ?? homedir();
	const globalPath = join(home, ".config", "planestories", "config.json");
	if (existsSync(globalPath)) {
		return globalPath;
	}

	return undefined;
}

/**
 * Reads and parses a JSON config file. Throws ConfigError on I/O or
 * parse failures.
 */
async function readConfigFile(filePath: string): Promise<unknown> {
	try {
		const text = await Bun.file(filePath).text();
		try {
			return JSON.parse(text);
		} catch {
			throw new ConfigError(`Malformed JSON in config file: ${filePath}`);
		}
	} catch (error) {
		if (error instanceof ConfigError) {
			throw error;
		}
		throw new ConfigError(`Failed to read config file: ${filePath}`);
	}
}

/**
 * Converts a validated CliConfig into a fully-resolved ResolvedConfig,
 * filling in defaults for optional fields.
 */
function resolveConfig(
	config: CliConfig,
	options: { allowMissingCredentials?: boolean; contextName?: string } = {},
): ResolvedConfig {
	return {
		// However the context was chosen — flag, default, or being the only one.
		contextName: options.contextName,
		apiKey: config.apiKey as string,
		workspaceSlug: config.workspaceSlug as string,
		// On the credential-free path, do NOT invent the production base URL: a
		// snapshot run must never look like a live instance, and an empty string is
		// visibly not one. With credentials, the default is correct as before.
		baseUrl: config.baseUrl ?? (options.allowMissingCredentials ? "" : DEFAULT_PLANE_BASE_URL),
		dialect: config.dialect ?? "issues",
		defaultProject: config.defaultProject ?? null,
		defaultLabels: config.defaultLabels ?? [],
		sourceLabel: config.sourceLabel ?? null,
		maxRetries: parseMaxRetries(process.env.PLANE_MAX_RETRIES),
		apiRateLimit:
			config.apiRateLimit === undefined
				? undefined
				: parseApiRateLimit(config.apiRateLimit, "apiRateLimit"),
		maxConcurrency:
			config.maxConcurrency === undefined
				? undefined
				: parseMaxConcurrency(config.maxConcurrency, "maxConcurrency"),
		rateHeadroom:
			config.rateHeadroom === undefined
				? undefined
				: parseRateHeadroom(config.rateHeadroom, "rateHeadroom"),
	};
}

/** Parse Plane's API_KEY_RATE_LIMIT form (or a numeric rpm) into requests per minute. */
export function parseApiRateLimit(raw: string | number, field: string): number {
	let rpm: number;
	if (typeof raw === "number") {
		rpm = raw;
	} else {
		// Env vars are always strings, so a bare integer must parse the same way
		// the JSON number does — otherwise PLANE_API_RATE_LIMIT=600 is an error
		// while {"apiRateLimit": 600} works.
		const match = raw.match(/^\s*(\d+)\s*(?:\/\s*minute\s*)?$/i);
		rpm = match ? Number(match[1]) : Number.NaN;
	}
	if (!Number.isSafeInteger(rpm) || rpm <= 0) {
		throw new ConfigError(
			`Invalid config field "${field}": expected a positive integer rpm or Plane form "60/minute", got ${JSON.stringify(raw)}`,
		);
	}
	return rpm;
}

function parseMaxConcurrency(raw: number, field: string): number {
	if (!Number.isSafeInteger(raw) || raw <= 0) {
		throw new ConfigError(
			`Invalid config field "${field}": expected a positive integer, got ${JSON.stringify(raw)}`,
		);
	}
	return raw;
}

function parseRateHeadroom(raw: number, field: string): number {
	if (!Number.isFinite(raw) || raw <= 0 || raw > 1) {
		throw new ConfigError(
			`Invalid config field "${field}": expected a number in (0, 1], got ${JSON.stringify(raw)}`,
		);
	}
	return raw;
}

function parseDialect(raw: string, source: string): PlaneEndpointDialect {
	if (raw === "issues" || raw === "work-items") return raw;
	throw new ConfigError(
		`Invalid ${source}: expected "issues" or "work-items", got ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse PLANE_MAX_RETRIES from the environment, falling back to the client default.
 * Non-numeric, negative, or empty values fall back rather than error — this is an
 * operational knob, not a hard requirement.
 */
function parseMaxRetries(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_MAX_RETRIES;
	}
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		return DEFAULT_MAX_RETRIES;
	}
	return Math.floor(n);
}
