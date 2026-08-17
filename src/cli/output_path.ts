import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import chalk from "chalk";

/**
 * Where Plane exports go.
 *
 * THE RULE: what the board-reading commands write — atlas renders, story exports, spec
 * packets — belongs under `exports/` at the REPOSITORY ROOT, and `exports/` is
 * gitignored. (Replication artifacts are deliberately NOT covered here; snapshots,
 * journals and verify reports have their own home outside the repo — see
 * `docs/REPLICATE.md`.)
 *
 * Why it exists: a `git add -A` after a smoke run once committed 49,258 lines of live
 * board content — an `atlas.json` and an `exported-stories.md` in the repo root,
 * because those were the default output paths. The export carried internal
 * infrastructure detail. Board exports are DATA: large, private to somebody's project,
 * and never one careless `git add` away from a public repository.
 *
 * Two subtleties that are easy to get wrong, and were:
 *
 *   1. **The root is the REPOSITORY, not the working directory.** `.gitignore`'s
 *      `/exports/` is root-anchored, so a default resolved against a subdirectory
 *      (`src/exports/atlas.html`) is NOT ignored — the accident, one directory over.
 *      We therefore walk up to the enclosing `.git`, exactly as `findRepoConfigPath`
 *      does, and fall back to the cwd when there is no repository at all. Running the
 *      CLI inside a DIFFERENT repository correctly targets that repository's
 *      `exports/`.
 *   2. **"Escapes the directory" is a path-SEGMENT question.** `relative()` +
 *      `startsWith("..")` says yes for `...hidden`, which is a perfectly ordinary file
 *      inside the directory, so such a path would have slipped through unwarned.
 */
export const EXPORTS_DIR = "exports";

/**
 * Nearest enclosing git repository, or `from` when there is none.
 *
 * A bare `existsSync(".git")` is not sufficient: an EMPTY `.git` directory is not a
 * repository, and one was found sitting in `/tmp` on this machine — which would make
 * every temp directory look like a repo root and send exports somewhere no `.gitignore`
 * covers. Require the marker to look real: a `.git` FILE (worktrees and submodules use
 * a gitdir pointer) or a `.git` directory containing `HEAD`.
 */
export function findRepoRoot(from: string = process.cwd()): string {
	let current = resolve(from);
	const { root } = parse(current);
	while (true) {
		if (looksLikeGitDir(join(current, ".git"))) return current;
		if (current === root) return resolve(from);
		current = dirname(current);
	}
}

function looksLikeGitDir(candidate: string): boolean {
	if (!existsSync(candidate)) return false;
	try {
		if (!statSync(candidate).isDirectory()) return true; // gitdir pointer file
	} catch {
		return false;
	}
	return existsSync(join(candidate, "HEAD"));
}

/** True when `rel` leaves its base directory — segment-wise, not by string prefix. */
function escapes(rel: string): boolean {
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** The default output path for a command: always `<repo>/exports/<filename>`. */
export function defaultExportPath(filename: string, repoRoot: string = findRepoRoot()): string {
	return resolve(repoRoot, EXPORTS_DIR, filename);
}

/** True when `target` sits inside the repo but outside `exports/`. */
export function isInsideRepoButNotExports(target: string, repoRoot: string): boolean {
	const absolute = resolve(target);
	if (escapes(relative(resolve(repoRoot), absolute))) return false;
	return escapes(relative(resolve(repoRoot, EXPORTS_DIR), absolute));
}

export interface ResolveOutputOptions {
	repoRoot?: string;
	/** Injectable so the warning itself can be asserted rather than assumed. */
	warn?: (message: string) => void;
}

/**
 * Resolve an output path, create its directory, and warn when an explicit path lands
 * inside the repository but outside `exports/` — the exact shape of the accident.
 *
 * The rule warns rather than forbids: writing to a scratch directory or
 * `~/plane-replication` is legitimate and common, and refusing it would fight real
 * workflows. Paths outside the repository stay silent.
 */
export function resolveOutputPath(
	requested: string | undefined,
	defaultName: string,
	options: ResolveOutputOptions = {},
): string {
	const repoRoot = options.repoRoot ?? findRepoRoot();
	const warn = options.warn ?? ((message: string) => console.error(chalk.yellow(message)));
	const target = requested
		? resolve(process.cwd(), requested)
		: defaultExportPath(defaultName, repoRoot);

	mkdirSync(dirname(target), { recursive: true });

	if (isInsideRepoButNotExports(target, repoRoot)) {
		warn(
			`⚠ Writing board content to ${relative(repoRoot, target)}, which is inside the repository and outside ${EXPORTS_DIR}/. ` +
				`Exports are data — large, private, and one \`git add -A\` from being committed forever. Prefer ${EXPORTS_DIR}/ or a path outside the repo.`,
		);
	}
	return target;
}
