import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `--with-activity` must be a REGISTERED option of `replicate snapshot`.
 *
 * The engine-level tests in tests/unit/replicate/snapshot.test.ts prove what
 * capture DOES; they cannot prove the CLI exposes it, because they call
 * takeSnapshot directly. That is exactly the "wrong layer" trap recorded in
 * docs/HANDOFF.md §10b — a green unit suite over a flag no user can reach.
 *
 * KNOWN RESIDUAL, stated rather than papered over: this proves the option is
 * registered and accepted, not that its value reaches takeSnapshot, because
 * `replicate snapshot` needs a live client and cannot run offline. The one
 * uncovered link is the identifier spelling in `withActivity: options.withActivity`
 * (commander derives `withActivity` from `--with-activity` by a fixed rule).
 * Closing it properly needs runSnapshot to take an injectable client — worth
 * doing if this file ever grows a second case.
 */
function runCli(args: string[], cwd: string): { stdout: string; stderr: string } {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	// Hermetic: strip PLANE_* so a gitignored .env on the dev box cannot make this
	// pass for a reason a fresh clone would not reproduce.
	const env: Record<string, string> = { FORCE_COLOR: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawnSync(["bun", "run", cli, ...args], { env, cwd });
	return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

test("replicate snapshot registers --with-activity and documents its cost", () => {
	const dir = mkdtempSync(join(tmpdir(), "planestories-withactivity-"));
	try {
		const help = runCli(["replicate", "snapshot", "--help"], dir);
		// Commander hard-wraps help text to the terminal width, so a phrase can be
		// split across lines. Collapse whitespace before matching, or this test
		// fails for a formatting reason that has nothing to do with the flag.
		const text = `${help.stdout}${help.stderr}`.replace(/\s+/g, " ");
		expect(text).toContain("--with-activity");
		// The help must state the cost: this flag adds one request per item, and an
		// operator sizing a run against a rate-limited instance needs that up front.
		expect(text).toMatch(/request per item/i);

		// Accepted, not rejected. The control below proves this assertion can fail:
		// an unregistered flag produces "unknown option", so deleting the .option()
		// call turns this green assertion red.
		const accepted = runCli(
			["replicate", "snapshot", "--with-activity", "-p", "X", "-o", join(dir, "x.json")],
			dir,
		);
		expect(accepted.stderr + accepted.stdout).not.toContain("unknown option");

		const control = runCli(
			["replicate", "snapshot", "--no-such-flag", "-p", "X", "-o", join(dir, "y.json")],
			dir,
		);
		expect(control.stderr + control.stdout).toContain("unknown option");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
