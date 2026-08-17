import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	EXPORTS_DIR,
	isInsideRepoButNotExports,
	resolveOutputPath,
} from "../../../src/cli/output_path.ts";

/**
 * The rule: board exports go under `exports/`, which is gitignored. This exists because
 * a `git add -A` after a smoke run once committed 49,258 lines of live board content —
 * two files sitting in the repo root because those were the default output paths.
 */
describe("export output paths", () => {
	function withRepo<T>(run: (repo: string) => T): T {
		const repo = mkdtempSync(join(tmpdir(), "planestories-out-"));
		try {
			return run(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	test("a repo-root path outside exports/ is flagged — the exact shape of the accident", () => {
		withRepo((repo) => {
			expect(isInsideRepoButNotExports(join(repo, "atlas.json"), repo)).toBe(true);
			expect(isInsideRepoButNotExports(join(repo, "docs", "atlas.json"), repo)).toBe(true);
		});
	});

	test("anywhere under exports/ is fine", () => {
		withRepo((repo) => {
			expect(isInsideRepoButNotExports(join(repo, EXPORTS_DIR, "atlas.json"), repo)).toBe(false);
			expect(isInsideRepoButNotExports(join(repo, EXPORTS_DIR, "runs", "atlas.json"), repo)).toBe(
				false,
			);
		});
	});

	test("paths OUTSIDE the repo are not flagged — writing to a scratch dir is legitimate", () => {
		withRepo((repo) => {
			// The operator keeps snapshots in ~/plane-replication; that must stay quiet.
			expect(isInsideRepoButNotExports("/tmp/somewhere/data.snapshot.json", repo)).toBe(false);
		});
	});

	test("a default path lands in exports/ and its directory is created", () => {
		withRepo((repo) => {
			const cwd = process.cwd();
			process.chdir(repo);
			try {
				const target = resolveOutputPath(undefined, "atlas.html", repo);
				expect(target).toBe(resolve(repo, EXPORTS_DIR, "atlas.html"));
				expect(existsSync(resolve(repo, EXPORTS_DIR))).toBe(true);
			} finally {
				process.chdir(cwd);
			}
		});
	});

	test("an explicit path is still honoured — the rule warns, it does not forbid", () => {
		withRepo((repo) => {
			const cwd = process.cwd();
			process.chdir(repo);
			try {
				const target = resolveOutputPath("custom/place.md", "atlas.html", repo);
				expect(target).toBe(resolve(repo, "custom", "place.md"));
				expect(existsSync(resolve(repo, "custom"))).toBe(true);
			} finally {
				process.chdir(cwd);
			}
		});
	});
});
