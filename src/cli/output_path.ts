import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import chalk from "chalk";

/**
 * Where Plane exports go.
 *
 * THE RULE: everything a command writes out of a board — atlas renders, story
 * exports, spec packets, snapshots, reports — belongs under `exports/` (or a
 * subdirectory of it), and `exports/` is gitignored.
 *
 * Why it exists: a `git add -A` after a smoke run once committed 49,258 lines of live
 * board content to a feature branch — an `atlas.json` and an `exported-stories.md`
 * sitting in the repo root because those were the default output paths. The export
 * carried internal infrastructure detail, and had it merged it would have been in
 * history permanently. Board exports are DATA: they are large, they are somebody's
 * private project content, and they must never be one careless `git add` away from a
 * public repository.
 *
 * How it is enforced, in order of strength:
 *   1. Every default output path points inside `exports/`, so the common case is safe
 *      without anyone knowing the rule.
 *   2. An explicit `-o` is still honoured — writing to `~/plane-replication` or a
 *      scratch directory is legitimate and common — but if the path lands INSIDE the
 *      repository and OUTSIDE `exports/`, the command says so loudly, because that is
 *      the exact shape of the accident.
 */
export const EXPORTS_DIR = "exports";

/** The default output path for a command, always inside `exports/`. */
export function defaultExportPath(filename: string): string {
	return resolve(process.cwd(), EXPORTS_DIR, filename);
}

/**
 * Resolve a user-supplied or default output path, create its directory, and warn when
 * it lands in the repository outside `exports/`.
 *
 * @param requested   the `-o` value, or undefined to use the default
 * @param defaultName filename used under `exports/` when nothing was requested
 * @param repoRoot    injectable for tests; defaults to the current working directory
 */
export function resolveOutputPath(
	requested: string | undefined,
	defaultName: string,
	repoRoot: string = process.cwd(),
): string {
	const target = requested ? resolve(process.cwd(), requested) : defaultExportPath(defaultName);
	mkdirSync(dirname(target), { recursive: true });

	if (requested && isInsideRepoButNotExports(target, repoRoot)) {
		console.error(
			chalk.yellow(
				`⚠ Writing board content to ${relative(repoRoot, target)}, which is inside the repository and outside ${EXPORTS_DIR}/. ` +
					`Exports are data — large, private, and one \`git add -A\` from being committed forever. Prefer ${EXPORTS_DIR}/ or a path outside the repo.`,
			),
		);
	}
	return target;
}

/** True when `target` sits in the repo but not under `exports/`. */
export function isInsideRepoButNotExports(target: string, repoRoot: string): boolean {
	const fromRoot = relative(repoRoot, target);
	const escapesRepo = fromRoot.startsWith("..") || isAbsolute(fromRoot);
	if (escapesRepo) return false;
	const fromExports = relative(resolve(repoRoot, EXPORTS_DIR), target);
	const outsideExports = fromExports.startsWith("..") || isAbsolute(fromExports);
	return outsideExports;
}
