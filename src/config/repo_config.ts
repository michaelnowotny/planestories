import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "../errors.ts";
import { ALL_LINT_RULES, type LintRule } from "../lint/rules.ts";

/** True if a filesystem entry exists at `p` — including a DANGLING symlink (lstat
 *  doesn't follow the link), so a broken config symlink is surfaced, not skipped. */
function entryExists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** The lint conventions a repo can pin so CI/authoring need no per-invocation flags. */
export interface RepoLintConfig {
	/** Default lint mode: "error" (fail on findings, the default) or "warn" (report only). */
	strictness?: "warn" | "error";
	/** Lint rules to skip for this repo (e.g. a repo not yet requiring effort). */
	disable?: LintRule[];
}

/**
 * A repo-local house-conventions file (`.planestories.yml`). Distinct from the
 * JSON credentials/context config (`.planestoriesrc.json` / `~/.config`): this
 * holds only non-secret conventions, committed to the repo. v1 covers lint.
 */
export interface RepoConfig {
	lint?: RepoLintConfig;
}

export const REPO_CONFIG_FILENAME = ".planestories.yml";

const KNOWN_RULES: ReadonlySet<string> = new Set<LintRule>(ALL_LINT_RULES);

/**
 * Find `.planestories.yml` in `startDir` or an ancestor, stopping at the enclosing
 * repository root (the first ancestor containing a `.git`) so the file stays
 * genuinely REPO-local — a stray `~/.planestories.yml` never applies. Returns null
 * if no config exists within the repo (or, outside any repo, up to the fs root).
 */
export function findRepoConfigPath(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const candidate = join(dir, REPO_CONFIG_FILENAME);
		// lstat-based: a dangling `.planestories.yml` symlink is FOUND here, then
		// fails loudly on read in loadRepoConfig rather than being silently skipped.
		if (entryExists(candidate)) {
			return candidate;
		}
		// A directory containing `.git` is the repo root — don't search above it.
		if (existsSync(join(dir, ".git"))) {
			return null;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null; // reached the filesystem root
		}
		dir = parent;
	}
}

/**
 * Load + validate the repo conventions file, discovered upward from `cwd`. Returns
 * an empty config when no file exists. A present-but-INVALID file fails loudly
 * (never silently ignored) — an unknown key, a bad `strictness`, or an unknown
 * rule name in `disable` throws a ConfigError naming the file and the problem.
 */
export async function loadRepoConfig(cwd: string = process.cwd()): Promise<RepoConfig> {
	const path = findRepoConfigPath(cwd);
	if (!path) {
		return {};
	}
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		// e.g. a dangling symlink — surface it, never silently ignore.
		throw new ConfigError(
			`${path}: cannot read repo config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let parsed: unknown;
	try {
		// The `yaml` package (works on any Bun/Node) — NOT Bun.YAML (absent on older
		// Bun) and NOT frontmatter framing. It THROWS on a duplicate mapping key and
		// on multiple `---` documents, so neither can silently bypass validation.
		parsed = parseYaml(text);
	} catch (error) {
		throw new ConfigError(
			`${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// An empty/comment-only file (parses to null) is a legitimately empty config.
	if (parsed === null || parsed === undefined) {
		return {};
	}
	// Anything that isn't a top-level mapping is malformed — reject loudly.
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(
			`${path}: expected a YAML mapping at the top level (a "lint:" section), got ${
				Array.isArray(parsed) ? "a list" : typeof parsed
			}.`,
		);
	}

	return validateRepoConfig(parsed as Record<string, unknown>, path);
}

/** Validate a parsed conventions object. Exported for unit testing. */
export function validateRepoConfig(data: unknown, path: string): RepoConfig {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new ConfigError(`${path}: expected a YAML mapping at the top level.`);
	}
	const record = data as Record<string, unknown>;
	const config: RepoConfig = {};
	const unknownTop = Object.keys(record).filter((k) => k !== "lint");
	if (unknownTop.length > 0) {
		throw new ConfigError(
			`${path}: unknown key(s): ${unknownTop.join(", ")}. Only "lint" is supported.`,
		);
	}

	if (record.lint !== undefined) {
		if (typeof record.lint !== "object" || record.lint === null || Array.isArray(record.lint)) {
			throw new ConfigError(`${path}: "lint" must be a mapping.`);
		}
		const lintRaw = record.lint as Record<string, unknown>;
		const unknownLint = Object.keys(lintRaw).filter((k) => k !== "strictness" && k !== "disable");
		if (unknownLint.length > 0) {
			throw new ConfigError(
				`${path}: unknown lint key(s): ${unknownLint.join(", ")}. Supported: strictness, disable.`,
			);
		}

		const lint: RepoLintConfig = {};
		if (lintRaw.strictness !== undefined) {
			if (lintRaw.strictness !== "warn" && lintRaw.strictness !== "error") {
				throw new ConfigError(
					`${path}: lint.strictness must be "warn" or "error" (got ${JSON.stringify(lintRaw.strictness)}).`,
				);
			}
			lint.strictness = lintRaw.strictness;
		}
		if (lintRaw.disable !== undefined) {
			if (!Array.isArray(lintRaw.disable)) {
				throw new ConfigError(`${path}: lint.disable must be a list of rule names.`);
			}
			const disable: LintRule[] = [];
			for (const entry of lintRaw.disable) {
				if (typeof entry !== "string" || !KNOWN_RULES.has(entry)) {
					throw new ConfigError(
						`${path}: lint.disable has an unknown rule ${JSON.stringify(entry)}. Known rules: ${[
							...KNOWN_RULES,
						].join(", ")}.`,
					);
				}
				disable.push(entry as LintRule);
			}
			lint.disable = disable;
		}
		config.lint = lint;
	}

	return config;
}
