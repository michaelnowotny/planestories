import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version lives in THREE places and nothing enforced that they agree.
 *
 * Two of them are cosmetic if they drift (`package.json`, `--version` output).
 * The third is not: `TOOL_VERSION` is stamped into every replication SNAPSHOT
 * and JOURNAL record, so a stale constant means the provenance on a migration
 * artifact is a lie — and provenance is the entire point of recording it. You
 * would discover it while trying to work out which build produced a bad cutover,
 * which is the worst possible moment.
 *
 * `docs/HANDOFF.md` §9.2 flagged this as "a test asserting all three agree would
 * be a worthwhile addition". This is it.
 */

const root = join(import.meta.dir, "../..");

function packageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
	expect(pkg.version).toBeString();
	return pkg.version as string;
}

/** The string in a single-argument call like `.version("1.2.3")`. */
function versionInSource(relativePath: string, pattern: RegExp): string {
	const source = readFileSync(join(root, relativePath), "utf8");
	const match = source.match(pattern);
	// A null here means the DECLARATION moved or was renamed — the test must fail
	// loudly rather than skip, or it silently stops guarding anything.
	expect(match?.[1]).toBeString();
	return match?.[1] as string;
}

describe("version agreement", () => {
	test("package.json, the CLI --version, and TOOL_VERSION are the same string", () => {
		const fromPackage = packageVersion();
		const fromCli = versionInSource("src/cli/index.ts", /\.version\(\s*"([^"]+)"\s*\)/);
		const fromConstants = versionInSource("src/constants.ts", /TOOL_VERSION\s*=\s*"([^"]+)"/);

		// Named in the failure so the message says WHICH one drifted.
		expect({ fromCli, fromConstants }).toEqual({
			fromCli: fromPackage,
			fromConstants: fromPackage,
		});
	});

	test("the version is a plain semver triple", () => {
		// `bun build --compile` and the `v*` release tag both assume this shape.
		expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
