import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSnapshotDigest, serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import type { SnapshotItem } from "../../../src/replicate/types.ts";
import { sampleSnapshot } from "../replicate/fixtures.ts";

/**
 * `--json` already existed on the graph verbs. These tests drive `--limit` and
 * `--updated-since` through argv. A limit that only sliced the denominator, or
 * a time filter that treated a missing updatedAt as old, would still pass a
 * help-text assertion.
 */

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

const NOW = Date.now();
const EXACT = "2026-08-01T12:00:00.000Z";

function item(sequenceId: number, overrides: Partial<SnapshotItem> = {}): SnapshotItem {
	return {
		id: `id-${sequenceId}`,
		sequenceId,
		name: `Item ${sequenceId}`,
		descriptionHtml: "<p>Work.</p>",
		priority: "medium",
		point: null,
		stateId: "state-backlog",
		parentId: null,
		labelIds: [],
		assigneeIds: [],
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		createdBy: null,
		startDate: null,
		targetDate: null,
		completedAt: null,
		externalSource: null,
		externalId: null,
		archived: false,
		...overrides,
	};
}

function effort(days: number): string {
	return `<p><strong>Effort:</strong> ${days} dev-days</p>`;
}

function scriptingSnapshot(): string {
	const snapshot = sampleSnapshot();
	snapshot.states.push(
		{
			id: "state-done",
			name: "Done",
			group: "completed",
			color: "#333333",
			description: "",
			isDefault: false,
		},
		{
			id: "state-cancelled",
			name: "Cancelled",
			group: "cancelled",
			color: "#444444",
			description: "",
			isDefault: false,
		},
	);
	const done = { stateId: "state-done", completedAt: "2024-06-01T00:00:00.000Z" };
	snapshot.items = [
		item(1, { descriptionHtml: effort(2), updatedAt: EXACT }),
		item(2, { descriptionHtml: effort(3) }),
		item(3, { descriptionHtml: effort(4) }),
		item(4, { descriptionHtml: effort(1) }),
		item(5, { stateId: "state-review" }),
		item(6),
		item(7),
		item(8),
		item(9, { updatedAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
		item(10, { updatedAt: new Date(NOW).toISOString() }),
		item(11, { updatedAt: null }),
		item(12, done),
		item(13),
		item(14, done),
		item(15, { stateId: "state-cancelled", name: "Cancelled programme" }),
		item(16, { parentId: "id-15" }),
		item(17, done),
		item(18),
		item(19, { parentId: "id-15" }),
	];
	snapshot.relations = {
		"id-2": { blocked_by: ["id-1"] },
		"id-3": { blocked_by: ["id-2"] },
		"id-4": { blocked_by: ["id-3"] },
		"id-6": { blocked_by: ["id-5"] },
		"id-7": { blocked_by: ["id-5"] },
		"id-8": { blocked_by: ["id-5"] },
		"id-12": { blocked_by: ["id-5"] },
		"id-13": { blocked_by: ["id-14"] },
		"id-17": { blocked_by: ["id-5"] },
		"id-18": { blocked_by: ["id-14"] },
	};
	snapshot.comments = {};
	const present = snapshot.items.map((row) => row.sequenceId);
	snapshot.sequence = { max: 19, present, gaps: [] };
	snapshot.digest = computeSnapshotDigest(snapshot);
	return serializeSnapshot(snapshot);
}

function withBoard(fn: (directory: string, snapshotPath: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "planestories-scripting-"));
	try {
		const snapshotPath = join(directory, "board.snapshot.json");
		writeFileSync(snapshotPath, scriptingSnapshot());
		fn(directory, snapshotPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function ids(payload: {
	items: Array<{ item?: { identifier: string }; identifier?: string }>;
}): string[] {
	return payload.items.map((row) => row.item?.identifier ?? row.identifier ?? "");
}

function firstId(payload: {
	items: Array<{ item?: { identifier: string }; identifier?: string }>;
}): string {
	const first = ids(payload)[0];
	if (first === undefined) throw new Error("expected at least one row");
	return first;
}

test("blocked --limit keeps the open denominator and the full match count", () => {
	withBoard((directory, snapshotPath) => {
		const full = runCli(["blocked", "--from-snapshot", snapshotPath, "--json"], directory);
		const limited = runCli(
			["blocked", "--limit", "1", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);

		expect(full.code).toBe(0);
		expect(limited.code).toBe(0);
		const all = JSON.parse(full.out);
		const some = JSON.parse(limited.out);
		expect(all.matched).toBeUndefined();
		expect(ids(some)).toEqual([firstId(all)]);
		expect(some.items).toHaveLength(1);
		expect(some.matched).toBe(all.items.length);
		expect(some.matched).toBeGreaterThan(1);
		expect(some.openConsidered).toBe(all.openConsidered);
		expect(some.openConsidered).toBeGreaterThan(some.matched);
	});
});

test("inconsistent --limit applies to each list and keeps the considered count", () => {
	withBoard((directory, snapshotPath) => {
		const full = runCli(["inconsistent", "--from-snapshot", snapshotPath, "--json"], directory);
		const limited = runCli(
			["inconsistent", "--limit", "1", "--from-snapshot", snapshotPath, "--json"],
			directory,
		);
		expect(full.code).toBe(0);
		expect(limited.code).toBe(0);
		const all = JSON.parse(full.out);
		const some = JSON.parse(limited.out);
		expect(all.matched).toBeUndefined();
		expect(some.considered).toBe(all.considered);
		expect(some.doneWithUnfinishedBlockers).toHaveLength(1);
		expect(some.notStartedWithDoneBlockers).toHaveLength(1);
		expect(some.matched.doneWithUnfinishedBlockers).toBe(all.doneWithUnfinishedBlockers.length);
		expect(some.matched.notStartedWithDoneBlockers).toBe(all.notStartedWithDoneBlockers.length);
		expect(some.matched.doneWithUnfinishedBlockers).toBeGreaterThan(1);
		expect(some.matched.notStartedWithDoneBlockers).toBeGreaterThan(1);
	});
});

test("orphans and abandoned --limit keep their denominators", () => {
	withBoard((directory, snapshotPath) => {
		for (const command of ["orphans", "abandoned"] as const) {
			const full = runCli([command, "--from-snapshot", snapshotPath, "--json"], directory);
			const limited = runCli(
				[command, "--limit", "1", "--from-snapshot", snapshotPath, "--json"],
				directory,
			);
			expect(full.code).toBe(0);
			expect(limited.code).toBe(0);
			const all = JSON.parse(full.out);
			const some = JSON.parse(limited.out);
			expect(ids(some)).toEqual([firstId(all)]);
			expect(some.matched).toBe(all.items.length);
			expect(some.matched).toBeGreaterThan(1);
			if (command === "orphans") expect(some.considered).toBe(all.considered);
			else expect(some.openConsidered).toBe(all.openConsidered);
		}
	});
});

test("a bad --limit is refused before a snapshot is opened", () => {
	const directory = mkdtempSync(join(tmpdir(), "planestories-scripting-limit-"));
	try {
		const result = runCli(
			["blocked", "--limit", "0", "--from-snapshot", join(directory, "missing.json")],
			directory,
		);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("positive integer");
		expect(result.err).not.toContain("Read from snapshot");
		expect(result.out).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("critical-path --limit shortens the chain and leaves the floor whole", () => {
	const directory = mkdtempSync(join(tmpdir(), "planestories-scripting-chain-"));
	try {
		const file = join(directory, "chain.md");
		writeFileSync(
			file,
			[
				"---",
				'project: "Chain"',
				"---",
				"",
				story("SRC-1", 2, ["SRC-2"]),
				story("SRC-2", 3, ["SRC-3"]),
				story("SRC-3", 4, ["SRC-4"]),
				story("SRC-4", 1, []),
			].join("\n"),
		);
		const full = runCli(["critical-path", "chain.md", "--json"], directory);
		const limited = runCli(["critical-path", "chain.md", "--limit", "2", "--json"], directory);
		const human = runCli(["critical-path", "chain.md", "--limit", "2"], directory);

		expect(full.code).toBe(0);
		expect(limited.code).toBe(0);
		expect(human.code).toBe(0);
		const all = JSON.parse(full.out);
		const some = JSON.parse(limited.out);
		expect(all.chain.map((node: { identifier: string }) => node.identifier)).toEqual([
			"SRC-1",
			"SRC-2",
			"SRC-3",
			"SRC-4",
		]);
		expect(all.chainLength).toBeUndefined();
		expect(some.chain.map((node: { identifier: string }) => node.identifier)).toEqual([
			"SRC-1",
			"SRC-2",
		]);
		expect(some.totalDays).toBe(all.totalDays);
		expect(some.totalDays).toBe(10);
		expect(some.chainLength).toBe(4);
		expect(some.limit).toBe(2);
		expect(human.out).toContain("10 dev-days across 4 items");
		expect(human.out).toContain("Showing 2 of 4");
		expect(human.out).toContain("full chain");
		expect(human.out).not.toContain("SRC-4");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function story(identifier: string, days: number, blocks: string[]): string {
	const blocksLine = blocks.length > 0 ? `blocks: [${blocks.join(", ")}]` : "";
	return [
		`## ${identifier}`,
		"",
		"```yaml",
		`plane_identifier: ${identifier}`,
		"status: Backlog",
		`effort_days: ${days}`,
		blocksLine,
		"```",
		"",
		"Work.",
		"",
	]
		.filter((line) => line !== "")
		.join("\n");
}

test("--updated-since filters ls and count without shrinking the denominator", () => {
	withBoard((directory, snapshotPath) => {
		const args = ["--from-snapshot", snapshotPath, "--json"] as const;
		const all = runCli(["ls", ...args], directory);
		const hour = runCli(["ls", "--updated-since", "1h", ...args], directory);
		const three = runCli(["ls", "--updated-since", "3h", ...args], directory);
		const bound = runCli(["ls", "--updated-since", EXACT, ...args], directory);
		const after = runCli(["ls", "--updated-since", "2026-08-01T12:00:01Z", ...args], directory);
		const counted = runCli(
			["count", "--updated-since", "1h", "--group-by", "status", ...args],
			directory,
		);
		const human = runCli(
			["count", "--updated-since", "1h", "--from-snapshot", snapshotPath],
			directory,
		);

		expect(all.code).toBe(0);
		expect(hour.code).toBe(0);
		expect(three.code).toBe(0);
		expect(bound.code).toBe(0);
		expect(after.code).toBe(0);
		expect(counted.code).toBe(0);
		expect(human.code).toBe(0);

		const everything = JSON.parse(all.out);
		const lastHour = JSON.parse(hour.out);
		const lastThree = JSON.parse(three.out);
		const atBound = JSON.parse(bound.out);
		const justAfter = JSON.parse(after.out);
		const count = JSON.parse(counted.out);

		expect(everything.updatedSinceUnknown).toBeUndefined();
		expect(everything.predicates.updatedSince).toBeUndefined();
		expect(lastHour.denominator).toBe(everything.denominator);
		expect(lastHour.denominator).toBeGreaterThan(1);
		expect(ids(lastHour)).toEqual(["SRC-10"]);
		expect(ids(lastThree).sort()).toEqual(["SRC-10", "SRC-9"]);
		expect(ids(atBound)).toContain("SRC-1");
		expect(ids(justAfter)).not.toContain("SRC-1");
		expect(ids(justAfter)).toContain("SRC-10");
		expect(lastHour.updatedSinceUnknown).toBe(1);
		expect(lastHour.count).toBe(1);
		expect(count.count).toBe(1);
		expect(count.denominator).toBe(everything.denominator);
		expect(count.groups[0].denominator).toBe(1);
		expect(count.predicates.updatedSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(human.out).toContain(`of ${everything.denominator} stories`);
		expect(human.out).toContain("no usable updatedAt");
		expect(human.out).not.toContain("SRC-11");
	});
});

test("a future --updated-since is refused before a snapshot is opened", () => {
	const directory = mkdtempSync(join(tmpdir(), "planestories-scripting-since-"));
	try {
		const result = runCli(
			["ls", "--updated-since", "2999-01-01", "--from-snapshot", join(directory, "missing.json")],
			directory,
		);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("future");
		expect(result.err).not.toContain("Read from snapshot");
		expect(result.out).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
