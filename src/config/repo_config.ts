import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import matter from "gray-matter";
import { ConfigError } from "../errors.ts";
import type { LintRule } from "../lint/rules.ts";

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

const KNOWN_RULES: ReadonlySet<string> = new Set<LintRule>([
	"missing-acceptance-criteria",
	"missing-effort",
	"epic-missing-why",
	"epic-has-acceptance-criteria",
	"dependency-self-reference",
	"dependency-cycle",
	"duplicate-identifier",
	"dangling-reference",
	"orphan-criterion",
	"bad-parent",
]);

/** Find `.planestories.yml` in `startDir` or any ancestor directory; null if none. */
export function findRepoConfigPath(startDir: string): string | null {
	let dir = startDir;
	const rootDir = parsePath(dir).root;
	// Walk up to (and including) the filesystem root.
	while (true) {
		const candidate = join(dir, REPO_CONFIG_FILENAME);
		if (existsSync(candidate)) {
			return candidate;
		}
		if (dir === rootDir) {
			return null;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
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
	const text = await Bun.file(path).text();

	let data: Record<string, unknown>;
	try {
		// Reuse gray-matter's YAML parser by framing the file as frontmatter.
		data = matter(`---\n${text}\n---\n`).data as Record<string, unknown>;
	} catch (error) {
		throw new ConfigError(
			`${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return validateRepoConfig(data, path);
}

/** Validate a parsed conventions object. Exported for unit testing. */
export function validateRepoConfig(data: Record<string, unknown>, path: string): RepoConfig {
	const config: RepoConfig = {};
	const unknownTop = Object.keys(data).filter((k) => k !== "lint");
	if (unknownTop.length > 0) {
		throw new ConfigError(
			`${path}: unknown key(s): ${unknownTop.join(", ")}. Only "lint" is supported.`,
		);
	}

	if (data.lint !== undefined) {
		if (typeof data.lint !== "object" || data.lint === null || Array.isArray(data.lint)) {
			throw new ConfigError(`${path}: "lint" must be a mapping.`);
		}
		const lintRaw = data.lint as Record<string, unknown>;
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
