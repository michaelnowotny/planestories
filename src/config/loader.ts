import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../errors.ts";
import { DEFAULT_PLANE_BASE_URL } from "../plane/client.ts";
import type { CliConfig, MultiContextConfig, ResolvedConfig } from "../types.ts";
import { assertConfigFile, isMultiContextConfig } from "./schema.ts";

export interface LoadConfigOptions {
	/** Explicit path to a config file (e.g. from --config flag) */
	configPath?: string;
	/** Working directory used for .planestoriesrc.json discovery */
	cwd?: string;
	/** Named context to select from a multi-context config */
	context?: string;
}

/**
 * Discovers, reads, validates, and resolves the CLI configuration.
 *
 * Discovery order:
 *   1. `options.configPath` -- explicit --config flag
 *   2. `.planestoriesrc.json` in `options.cwd` (or process.cwd())
 *   3. `~/.config/planestories/config.json`
 *
 * After loading the file the PLANE_* env vars are merged in (they override file
 * values). Credentials are expected to come from the environment (.env);
 * committed config files should hold only non-secret defaults. A ConfigError is
 * thrown when no API key or workspace slug is available from any source.
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig> {
	const configPath = resolveConfigPath(options);
	const raw = configPath ? await readConfigFile(configPath) : {};

	// Validate shape (flat or multi-context)
	assertConfigFile(raw);

	// Resolve multi-context → flat CliConfig
	let config: CliConfig;

	if (isMultiContextConfig(raw)) {
		const multiConfig = raw as MultiContextConfig;
		const contextName = options?.context;

		if (!contextName) {
			const names = multiConfig.contexts.map((c) => c.name).join(", ");
			throw new ConfigError(
				`Config file contains multiple contexts. Use --context <name> to select one. Available contexts: ${names}`,
			);
		}

		const entry = multiConfig.contexts.find((c) => c.name === contextName);
		if (!entry) {
			const names = multiConfig.contexts.map((c) => c.name).join(", ");
			throw new ConfigError(`Context "${contextName}" not found. Available contexts: ${names}`);
		}

		config = {
			apiKey: entry.apiKey,
			workspaceSlug: entry.workspaceSlug,
			baseUrl: entry.baseUrl,
			defaultProject: entry.defaultProject,
			defaultLabels: entry.defaultLabels,
			sourceLabel: entry.sourceLabel,
		};
	} else {
		if (options?.context) {
			throw new ConfigError(
				"--context flag was specified but the config file does not use the multi-context format",
			);
		}
		config = raw as CliConfig;
	}

	// Merge env vars -- env takes precedence (credentials belong in .env).
	if (process.env.PLANE_API_KEY) {
		config.apiKey = process.env.PLANE_API_KEY;
	}
	if (process.env.PLANE_WORKSPACE_SLUG) {
		config.workspaceSlug = process.env.PLANE_WORKSPACE_SLUG;
	}
	if (process.env.PLANE_BASE_URL) {
		config.baseUrl = process.env.PLANE_BASE_URL;
	}
	if (process.env.PLANE_SOURCE_LABEL) {
		config.sourceLabel = process.env.PLANE_SOURCE_LABEL;
	}

	if (!config.apiKey) {
		throw new ConfigError(
			"No API key found. Set PLANE_API_KEY in your environment (.env). " +
				"Do not commit credentials to a config file.",
		);
	}

	if (!config.workspaceSlug) {
		throw new ConfigError(
			"No workspace slug found. Set PLANE_WORKSPACE_SLUG in your environment (.env) " +
				'or "workspaceSlug" in your config file (.planestoriesrc.json).',
		);
	}

	return resolveConfig(config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
function resolveConfig(config: CliConfig): ResolvedConfig {
	return {
		apiKey: config.apiKey as string,
		workspaceSlug: config.workspaceSlug as string,
		baseUrl: config.baseUrl ?? DEFAULT_PLANE_BASE_URL,
		defaultProject: config.defaultProject ?? null,
		defaultLabels: config.defaultLabels ?? [],
		sourceLabel: config.sourceLabel ?? null,
	};
}
