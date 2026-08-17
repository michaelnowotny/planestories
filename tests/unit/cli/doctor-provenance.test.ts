import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import { sampleSnapshot } from "../replicate/fixtures.ts";

/**
 * A stored `--json` artifact must be distinguishable from a live reading, forever.
 *
 * This runs the REAL command against a snapshot file — no network needed, which is the
 * whole point of --from-snapshot. A unit test that passes a hand-built object through a
 * helper would stay green if a command stopped emitting the field, which is exactly the
 * class of self-satisfied test this suite has already been caught by twice.
 */
test("doctor --json --from-snapshot embeds its provenance, and a revert would be caught", () => {
	const dir = mkdtempSync(join(tmpdir(), "planestories-provenance-"));
	try {
		const snapshot = sampleSnapshot();
		const file = join(dir, "board.snapshot.json");
		writeFileSync(file, serializeSnapshot(snapshot));
		const cli = join(import.meta.dir, "../../../src/cli/index.ts");

		const proc = Bun.spawnSync(
			["bun", "run", cli, "doctor", "--from-snapshot", file, "-p", snapshot.project.name, "--json"],
			{ env: { ...process.env, FORCE_COLOR: "0" } },
		);
		const stdout = proc.stdout.toString();
		const report = JSON.parse(stdout);

		expect(report.source).toEqual({ kind: "snapshot", takenAt: snapshot.takenAt });
		// stdout must stay machine-clean: the human-facing provenance line goes to stderr.
		expect(stdout).not.toContain("NOT live");
		expect(proc.stderr.toString()).toContain("NOT live");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
