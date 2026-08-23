import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph } from "../../../src/atlas/model.ts";
import { runGraphQueryCommand } from "../../../src/cli/commands/graph-queries.ts";
import { type GraphSourceResult, IncompleteGraphError } from "../../../src/cli/graph_source.ts";
import { computeSnapshotDigest, serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import type { ProjectSnapshot, SnapshotItem } from "../../../src/replicate/types.ts";
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

function snapshotItem(
	id: string,
	sequenceId: number,
	stateId: string,
	name: string,
	parentId: string | null = null,
): SnapshotItem {
	return {
		id,
		sequenceId,
		name,
		descriptionHtml: `<p>${name}</p>`,
		priority: null,
		point: null,
		stateId,
		parentId,
		labelIds: [],
		assigneeIds: [],
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		createdBy: null,
		startDate: null,
		targetDate: null,
		completedAt: stateId === "done" ? "2026-08-02T00:00:00Z" : null,
		externalSource: "planestories",
		externalId: `item-${sequenceId}`,
		archived: false,
	};
}

function querySnapshot(): ProjectSnapshot {
	const snapshot = sampleSnapshot();
	snapshot.states = [
		{
			id: "backlog",
			name: "Backlog",
			group: "backlog",
			color: "#111",
			description: "",
			isDefault: true,
		},
		{
			id: "started",
			name: "In Progress",
			group: "started",
			color: "#222",
			description: "",
			isDefault: false,
		},
		{
			id: "done",
			name: "Done",
			group: "completed",
			color: "#333",
			description: "",
			isDefault: false,
		},
		{
			id: "cancelled",
			name: "Abandoned",
			group: "cancelled",
			color: "#444",
			description: "",
			isDefault: false,
		},
	];
	snapshot.items = [
		snapshotItem("abandoned-epic", 1, "cancelled", "Abandoned generation"),
		snapshotItem("abandoned-child", 2, "backlog", "Open work left behind", "abandoned-epic"),
		snapshotItem("open-blocker", 3, "started", "Open evidence bucket"),
		snapshotItem("blocked-target", 4, "backlog", "Blocked target title"),
		snapshotItem("done-target", 5, "done", "Prematurely closed title"),
		snapshotItem("done-blocker", 6, "done", "Completed prerequisite title"),
		snapshotItem("ready-target", 7, "backlog", "Ready-but-not-started title"),
		snapshotItem("orphan", 8, "backlog", "Disconnected orphan title"),
	];
	snapshot.relations = {
		"blocked-target": { blocked_by: ["open-blocker"] },
		"done-target": { blocked_by: ["open-blocker"] },
		"ready-target": { blocked_by: ["done-blocker"] },
	};
	snapshot.comments = {};
	snapshot.sequence = { max: 8, present: [1, 2, 3, 4, 5, 6, 7, 8], gaps: [] };
	snapshot.digest = computeSnapshotDigest(snapshot);
	return snapshot;
}

function withSnapshot<T>(fn: (directory: string, snapshotPath: string) => T): T {
	const directory = mkdtempSync(join(tmpdir(), "planestories-graph-queries-"));
	try {
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, serializeSnapshot(querySnapshot()));
		return fn(directory, snapshotPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function emptyGraph(): AtlasGraph {
	return {
		project: "Partial Board",
		source: "board",
		nodes: [],
		edges: [],
		labels: [],
		assignees: [],
		statuses: [],
		counts: { epics: 0, stories: 0, criteria: 0, flagged: 0, edges: 0 },
	};
}

test("all five verbs are registered, print titled counterparts, and carry provenance", () => {
	withSnapshot((directory, snapshotPath) => {
		const ready = runCli(["ready", "--from-snapshot", snapshotPath], directory);
		const inconsistent = runCli(["inconsistent", "--from-snapshot", snapshotPath], directory);
		const blocked = runCli(["blocked", "--from-snapshot", snapshotPath], directory);
		const orphans = runCli(["orphans", "--from-snapshot", snapshotPath], directory);
		const abandoned = runCli(["abandoned", "--from-snapshot", snapshotPath], directory);

		for (const result of [ready, inconsistent, blocked, orphans, abandoned]) {
			expect(result.code).toBe(0);
			expect(result.out).toContain("Source: Source board");
			expect(result.out).toContain("snapshot taken 2025-01-01T00:00:00Z");
		}
		expect(ready.out).toContain("Blocked target title");
		expect(inconsistent.out).toContain("Open evidence bucket");
		expect(inconsistent.out).toContain("Completed prerequisite title");
		expect(blocked.out).toContain("Open evidence bucket");
		expect(orphans.out).toContain("Disconnected orphan title");
		expect(abandoned.out).toContain("Abandoned generation");
	});
});

test("blocked has no invented --owner option", () => {
	withSnapshot((directory) => {
		const help = runCli(["blocked", "--help"], directory);
		expect(help.code).toBe(0);
		expect(help.out).not.toContain("--owner");
	});
});

test("a missing epic exits non-zero and names the same-source command that would answer", () => {
	withSnapshot((directory, snapshotPath) => {
		const result = runCli(
			["ready", "--epic", "SRC-404", "--from-snapshot", snapshotPath],
			directory,
		);

		expect(result.code).not.toBe(0);
		expect(result.out).toBe("");
		expect(result.err).toContain('board "Source"');
		expect(result.err).toContain("planestories ls --json");
		expect(result.err).toContain("--from-snapshot");
		expect(result.err).toContain(snapshotPath);
	});
});

test("every dependency verb refuses a partial sweep and names commands that would answer", async () => {
	const source: GraphSourceResult = {
		provenance: {
			kind: "live",
			project: "Partial Board",
			baseUrl: "https://plane.example.test",
			workspaceSlug: "workspace",
		},
		coverage: { kind: "partial", failures: 2 },
		relationRecovered: 0,
		requireCompleteGraph(purpose: string): AtlasGraph {
			throw new IncompleteGraphError({ kind: "partial", failures: 2 }, purpose);
		},
		acceptPartialGraph(): AtlasGraph {
			return emptyGraph();
		},
		requireCachedWorkItems(): readonly never[] {
			return [];
		},
	};

	for (const kind of ["ready", "inconsistent", "blocked", "orphans", "abandoned"] as const) {
		const out: string[] = [];
		const err: string[] = [];
		const ok = await runGraphQueryCommand(
			kind,
			{},
			{
				resolveGraph: async () => source,
				stdout: (message) => out.push(message),
				stderr: (message) => err.push(message),
			},
		);

		expect(ok).toBe(false);
		expect(out).toEqual([]);
		expect(err.join("\n")).toContain("Refusing to compute");
		expect(err.join("\n")).toContain("Partial Board");
		expect(err.join("\n")).toContain(`planestories ${kind} --refresh`);
		expect(err.join("\n")).toContain(`planestories ${kind} --from-snapshot <file>`);
	}
});

test("an invalid --limit fails before resolving any graph source", async () => {
	let resolved = false;
	await expect(
		runGraphQueryCommand(
			"ready",
			{ limit: "not-a-number" },
			{
				resolveGraph: async () => {
					resolved = true;
					throw new Error("must not resolve");
				},
			},
		),
	).rejects.toThrow("positive integer");
	expect(resolved).toBe(false);
});

test("a cached answer's provenance footer includes its measured age", async () => {
	const fetchedAt = new Date(Date.now() - 14 * 60_000).toISOString();
	const value = emptyGraph();
	const source: GraphSourceResult = {
		provenance: {
			kind: "cache",
			project: "Partial Board",
			projectId: "project-id",
			baseUrl: "https://plane.example.test",
			workspaceSlug: "workspace",
			fetchedAt,
			itemCount: 0,
		},
		coverage: { kind: "complete" },
		relationRecovered: 0,
		requireCompleteGraph(): AtlasGraph {
			return value;
		},
		acceptPartialGraph(): AtlasGraph {
			return value;
		},
		requireCachedWorkItems(): readonly never[] {
			return [];
		},
	};
	const out: string[] = [];

	expect(
		await runGraphQueryCommand(
			"orphans",
			{},
			{ resolveGraph: async () => source, stdout: (v) => out.push(v) },
		),
	).toBe(true);
	expect(out.join("\n")).toMatch(/cached 1[34]m ago/);
	expect(out.join("\n")).toContain(`fetched ${fetchedAt}`);
});
