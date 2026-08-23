import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHtml } from "../../../src/markdown/html.ts";
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
	const directory = mkdtempSync(join(tmpdir(), "planestories-show-"));
	try {
		const snapshot = sampleSnapshot();
		const parent = snapshot.items.find((item) => item.id === "source-1")!;
		const target = snapshot.items.find((item) => item.id === "source-3")!;
		const counterpart = snapshot.items.find((item) => item.id === "source-5")!;
		parent.name = "Parent bucket";
		target.name = "Visible target";
		target.priority = "high";
		target.descriptionHtml = markdownToHtml(
			[
				"SECRET DESCRIPTION BODY",
				"",
				"**Effort:** 1.5 dev-days",
				"",
				"### Acceptance Criteria",
				"- [x] first criterion",
				"- [ ] second criterion",
			].join("\n"),
		);
		counterpart.name = "Relation counterpart title";
		counterpart.archived = false;
		snapshot.digest = computeSnapshotDigest(snapshot);
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, serializeSnapshot(snapshot));
		return fn(directory, snapshotPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("show renders the requested fields and a relation counterpart title", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(["show", "SRC-3", "--from-snapshot", snapshotPath], directory);

		expect(result.code).toBe(0);
		expect(result.out).toContain("SRC-3 — Visible target");
		expect(result.out).toContain("Status: Review");
		expect(result.out).toContain("Effort: 1.5 dev-days");
		expect(result.out).toContain("Priority: high");
		expect(result.out).toContain("Parent bucket");
		expect(result.out).toContain("Criteria: 1 of 2");
		expect(result.out).toContain("Relation counterpart title");
		expect(result.out).toContain("Source board");
		expect(result.out).not.toContain("SECRET DESCRIPTION BODY");
	});
});

test("show --json is machine-clean and embeds board/snapshot provenance", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(["show", "src-3", "--from-snapshot", snapshotPath, "--json"], directory);

		expect(result.code).toBe(0);
		const output = JSON.parse(result.out);
		expect(output.identifier).toBe("SRC-3");
		expect(output.parent).toEqual({ identifier: "SRC-1", title: "Parent bucket" });
		expect(output.criteria).toEqual({ completed: 1, total: 2 });
		expect(output.relations.relatesTo[0]).toMatchObject({
			title: "Relation counterpart title",
			status: "Backlog",
		});
		expect(output.provenance).toEqual({
			kind: "snapshot",
			project: "Source",
			baseUrl: "https://source.example.test",
			workspaceSlug: "source",
			takenAt: "2025-01-01T00:00:00Z",
		});
		expect(result.out).not.toContain("SECRET DESCRIPTION BODY");
		expect(result.err).toContain("NOT live");
	});
});

test("an unknown identifier exits non-zero and names the board it searched", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(
			["show", "SRC-404", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(result.code).not.toBe(0);
		expect(result.err).toContain("SRC-404");
		expect(result.err).toContain('board "Source"');
		expect(result.out).toBe("");
	});
});
