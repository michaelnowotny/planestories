import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	defaultExportPath,
	EXPORTS_DIR,
	findRepoRoot,
	isInsideRepoButNotExports,
	resolveOutputPath,
} from "../../../src/cli/output_path.ts";

/**
 * The rule: board exports go under `exports/` AT THE REPOSITORY ROOT, which is
 * gitignored. This exists because a `git add -A` after a smoke run once committed
 * 49,258 lines of live board content — two files in the repo root, because those were
 * the default output paths.
 */
describe("export output paths", () => {
	/** A temp directory that looks like a git repo, plus a subdirectory to run from. */
	function withRepo<T>(run: (repo: string, sub: string) => T): T {
		const repo = mkdtempSync(join(tmpdir(), "planestories-out-"));
		mkdirSync(join(repo, ".git"), { recursive: true });
		// An EMPTY .git is not a repository — see findRepoRoot. Make the marker real.
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
		const sub = join(repo, "src", "deep");
		mkdirSync(sub, { recursive: true });
		try {
			return run(repo, sub);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	function inDir<T>(dir: string, run: () => T): T {
		const previous = process.cwd();
		process.chdir(dir);
		try {
			return run();
		} finally {
			process.chdir(previous);
		}
	}

	describe("the repository root, not the working directory", () => {
		test("a default resolved from a SUBDIRECTORY still lands at the repo root", () => {
			// The hole this closes: `.gitignore`'s `/exports/` is root-anchored, so a
			// default written to `src/deep/exports/` would NOT be ignored — the same
			// accident, one directory over.
			withRepo((repo, sub) => {
				inDir(sub, () => {
					expect(resolveOutputPath(undefined, "atlas.html")).toBe(
						resolve(repo, EXPORTS_DIR, "atlas.html"),
					);
				});
			});
		});

		test("findRepoRoot walks up to .git, and falls back to the cwd without one", () => {
			withRepo((repo, sub) => {
				expect(findRepoRoot(sub)).toBe(repo);
			});
			// Also covers the stray-empty-.git case: a directory that merely CONTAINS
			// an empty .git must not be mistaken for a repository root.
			const bare = mkdtempSync(join(tmpdir(), "planestories-norepo-"));
			mkdirSync(join(bare, ".git"), { recursive: true });
			try {
				expect(findRepoRoot(bare)).toBe(resolve(bare));
			} finally {
				rmSync(bare, { recursive: true, force: true });
			}
		});
	});

	test("an EMPTY .git is a decoy: the walk continues to the real repository above it", () => {
		// The discriminating case. A test that only checks a lone empty .git passes
		// even with the old existsSync-only walk; nesting the decoy inside a real repo
		// is what distinguishes "reject the decoy" from "accept anything named .git".
		// (One such empty .git has sat in /tmp on this machine since 2026-07-30, which
		// is how this surfaced.)
		withRepo((repo) => {
			const decoy = join(repo, "vendor", "thing");
			mkdirSync(join(decoy, ".git"), { recursive: true });
			expect(findRepoRoot(decoy)).toBe(repo);
		});
	});

	describe("the predicate", () => {
		test("in-repo paths outside exports/ are flagged, including dot-prefixed names", () => {
			withRepo((repo) => {
				expect(isInsideRepoButNotExports(join(repo, "atlas.json"), repo)).toBe(true);
				expect(isInsideRepoButNotExports(join(repo, "docs", "atlas.json"), repo)).toBe(true);
				// Regression: `relative()` returns "...hidden", and a startsWith("..")
				// test called that an escape — so an ordinary in-repo file went unwarned.
				expect(isInsideRepoButNotExports(join(repo, "...hidden"), repo)).toBe(true);
				expect(isInsideRepoButNotExports(join(repo, "..foo", "atlas.json"), repo)).toBe(true);
			});
		});

		test("exports/ and its subdirectories are fine; prefix-siblings are not exports/", () => {
			withRepo((repo) => {
				expect(isInsideRepoButNotExports(join(repo, EXPORTS_DIR, "a.json"), repo)).toBe(false);
				expect(isInsideRepoButNotExports(join(repo, EXPORTS_DIR, "runs", "a.json"), repo)).toBe(
					false,
				);
				expect(isInsideRepoButNotExports(join(repo, "exports-old", "a.json"), repo)).toBe(true);
				expect(isInsideRepoButNotExports(join(repo, "exportsfoo", "a.json"), repo)).toBe(true);
			});
		});

		test("paths outside the repository are NOT flagged — scratch dirs are legitimate", () => {
			withRepo((repo) => {
				// Snapshots live in ~/plane-replication by design; that must stay quiet.
				expect(isInsideRepoButNotExports("/tmp/elsewhere/data.snapshot.json", repo)).toBe(false);
			});
		});

		test("a relative path that re-enters the repo from a subdirectory IS flagged", () => {
			withRepo((repo, sub) => {
				inDir(sub, () => {
					expect(isInsideRepoButNotExports(resolve("../../stray.md"), repo)).toBe(true);
				});
			});
		});
	});

	describe("the warning", () => {
		test("fires for an in-repo path outside exports/, and the file is still written there", () => {
			withRepo((repo) => {
				inDir(repo, () => {
					const warnings: string[] = [];
					const target = resolveOutputPath("custom/place.md", "atlas.html", {
						warn: (m) => warnings.push(m),
					});
					expect(target).toBe(resolve(repo, "custom", "place.md"));
					expect(existsSync(resolve(repo, "custom"))).toBe(true); // honoured, not forbidden
					expect(warnings).toHaveLength(1);
					expect(warnings[0]).toMatch(/inside the repository and outside exports\//);
				});
			});
		});

		test("stays silent for exports/ and for paths outside the repository", () => {
			withRepo((repo) => {
				inDir(repo, () => {
					const warnings: string[] = [];
					resolveOutputPath(undefined, "atlas.html", { warn: (m) => warnings.push(m) });
					resolveOutputPath(join(EXPORTS_DIR, "runs", "a.json"), "atlas.html", {
						warn: (m) => warnings.push(m),
					});
					const outside = join(tmpdir(), "planestories-outside-check", "a.json");
					resolveOutputPath(outside, "atlas.html", { warn: (m) => warnings.push(m) });
					rmSync(join(tmpdir(), "planestories-outside-check"), { recursive: true, force: true });
					expect(warnings).toEqual([]);
				});
			});
		});

		test("fires for `../file` from a subdirectory — it re-enters the repo", () => {
			withRepo((repo, sub) => {
				inDir(sub, () => {
					const warnings: string[] = [];
					const target = resolveOutputPath("../../stray.md", "atlas.html", {
						warn: (m) => warnings.push(m),
					});
					expect(target).toBe(resolve(repo, "stray.md"));
					expect(warnings).toHaveLength(1);
				});
			});
		});
	});

	test("defaultExportPath honours an injected root", () => {
		withRepo((repo) => {
			expect(defaultExportPath("x.md", repo)).toBe(resolve(repo, EXPORTS_DIR, "x.md"));
		});
	});
});
