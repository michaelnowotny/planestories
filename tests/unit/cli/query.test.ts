import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSnapshotDigest, serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import { sampleSnapshot } from "../replicate/fixtures.ts";

function runCli(args: string[], cwd: string): { code: number; out: string; err: string } {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	const env: Record<string, string> = { FORCE_COLOR: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawnSync(["bun", "run", cli, ...args], { env, cwd });
	return {
		code: proc.exitCode ?? -1,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function withSnapshot<T>(fn: (directory: string, snapshotPath: string) => T): T {
	const directory = mkdtempSync(join(tmpdir(), "planestories-query-"));
	try {
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, serializeSnapshot(sampleSnapshot()));
		return fn(directory, snapshotPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("count prints a denominator and snapshot board provenance", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(
			["count", "--epic", "SRC-1", "--open", "--from-snapshot", snapshotPath],
			directory,
		);

		expect(result.code).toBe(0);
		expect(result.out).toContain("1 open of 1");
		expect(result.out).toContain("Source: Source board");
		expect(result.out).toContain("snapshot taken 2025-01-01T00:00:00Z");
	});
});

test("ls --json is machine-clean and carries provenance", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(
			["ls", "--epic", "src-1", "--open", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(result.code).toBe(0);
		const output = JSON.parse(result.out);
		expect(output).toMatchObject({
			count: 1,
			denominator: 1,
			items: [{ identifier: "SRC-3" }],
			availableEpics: [{ identifier: "SRC-1", title: expect.any(String) }],
			provenance: {
				kind: "snapshot",
				project: "Source",
				takenAt: "2025-01-01T00:00:00Z",
			},
		});
		expect(result.out).not.toContain("Read from snapshot");
		expect(result.err).toContain("NOT live");
	});
});

test("ls exits non-zero when its explicitly named epic identifier is missing", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(["ls", "--epic", "SRC-404", "--from-snapshot", snapshotPath], directory);

		expect(result.code).not.toBe(0);
		expect(result.out).toBe("");
		expect(result.err).toContain("SRC-404");
		expect(result.err).toContain('board "Source"');
		expect(result.err).toContain("planestories ls --json");
		expect(result.err).toContain("jq -r");
		expect(result.err).toContain("--from-snapshot");
		expect(result.err).toContain(snapshotPath);
	});
});

test("a blank predicate fails before opening the selected board source", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(["ls", "--status", "", "--from-snapshot", snapshotPath], directory);

		expect(result.code).not.toBe(0);
		expect(result.err).toContain("--status must not be blank");
		expect(result.err).not.toContain("Read from snapshot");
	});
});

test("count group-by emits denominators in text and JSON", () => {
	withSnapshot((directory, snapshotPath) => {
		const human = runCli(
			["count", "--open", "--group-by", "status", "--from-snapshot", snapshotPath],
			directory,
		);
		const json = runCli(
			["count", "--open", "--group-by", "status", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(human.code).toBe(0);
		expect(human.out).toMatch(/Backlog: \d+ of \d+/);
		expect(json.code).toBe(0);
		const output = JSON.parse(json.out);
		expect(output.denominator).toBeNumber();
		expect(output.groups[0]).toMatchObject({
			count: expect.any(Number),
			denominator: output.count,
		});
	});
});

/**
 * `--no-estimate` shipped as a NO-OP: Commander maps a `--no-x` boolean onto
 * `options.x`, so `options.noEstimate` was never set and the predicate read
 * `undefined === true` on every run. `count --no-estimate --open` printed the
 * unfiltered open count and an operator would quote it as the unestimated pile.
 *
 * 921 tests did not catch it because the pure function was tested directly with
 * `{ noEstimate: true }`, and the CLI test only asserted `--help` CONTAINS the
 * string. Neither invokes the flag — so these go through the real CLI.
 *
 * The second test is the other half: dropping the `false` default is what makes
 * the mapping usable, and keeping it would have inverted the predicate into
 * "unestimated only, always".
 */
function mixedEffortSnapshot(): string {
	const snapshot = sampleSnapshot();
	const estimated = snapshot.items.find((candidate) => candidate.sequenceId === 6);
	if (!estimated) throw new Error("fixture changed: expected an item with sequenceId 6");
	estimated.descriptionHtml = "<p>Description 6</p><p><strong>Effort:</strong> 3 dev-days</p>";
	snapshot.digest = computeSnapshotDigest(snapshot);
	return serializeSnapshot(snapshot);
}

test("--no-estimate actually filters, and names itself truthfully in --json", () => {
	const directory = mkdtempSync(join(tmpdir(), "planestories-noestimate-"));
	try {
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, mixedEffortSnapshot());

		const all = runCli(["ls", "--from-snapshot", snapshotPath, "--json"], directory);
		const unestimated = runCli(
			["ls", "--no-estimate", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(all.code).toBe(0);
		expect(unestimated.code).toBe(0);
		const everything = JSON.parse(all.out);
		const filtered = JSON.parse(unestimated.out);

		// The predicate must report itself; `predicates` is what a script reads back.
		expect(everything.predicates.noEstimate).toBe(false);
		expect(filtered.predicates.noEstimate).toBe(true);

		// SRC-6 carries **Effort:** 3 dev-days and must drop out; the rest stay.
		const identifiers = (result: { items: Array<{ identifier: string | null }> }) =>
			result.items.map((row) => row.identifier);
		expect(identifiers(everything)).toContain("SRC-6");
		expect(identifiers(filtered)).not.toContain("SRC-6");
		expect(identifiers(filtered)).toContain("SRC-7");
		expect(filtered.count).toBe(everything.count - 1);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("count without --no-estimate counts everything, estimated rows included", () => {
	// Guards the fix's own failure mode: reading `options.estimate === false`
	// while a `false` DEFAULT remains would silently make every count an
	// unestimated-only count.
	const directory = mkdtempSync(join(tmpdir(), "planestories-noestimate-default-"));
	try {
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, mixedEffortSnapshot());

		const plain = runCli(["count", "--from-snapshot", snapshotPath, "--json"], directory);
		const filtered = runCli(
			["count", "--no-estimate", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(plain.code).toBe(0);
		expect(filtered.code).toBe(0);
		expect(JSON.parse(plain.out).count).toBeGreaterThan(JSON.parse(filtered.out).count);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("ls and count help expose only the fixed predicate surface", () => {
	withSnapshot((directory) => {
		for (const command of ["ls", "count"]) {
			const result = runCli([command, "--help"], directory);
			expect(result.code).toBe(0);
			for (const option of [
				"--open",
				"--status",
				"--label",
				"--assignee",
				"--epic",
				"--flagged",
				"--no-estimate",
				"--blocked",
			]) {
				expect(result.out).toContain(option);
			}
			expect(result.out).not.toContain("--query");
		}
	});
});
