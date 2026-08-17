import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PlaneApiError, ReplicateError } from "../../../src/errors.ts";
import { runBackup } from "../../../src/replicate/backup.ts";
import { parseSnapshot } from "../../../src/replicate/snapshot.ts";
import { FakePlane } from "./fake-plane.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
	const client = new FakePlane();
	const project = await client.createProject<{ id: string }>({ name: "Data", identifier: "DATA" });
	await client.createWorkItem(project.id, {
		name: "First",
		updated_at: "2026-01-01T00:00:00Z",
	});
	const dir = mkdtempSync(join(tmpdir(), "planestories-backup-"));
	directories.push(dir);
	return { client, projectId: project.id, dir };
}

function options(dir: string, overrides: Record<string, unknown> = {}) {
	return {
		dir,
		retain: 14,
		toolVersion: "test",
		checkFresh: true,
		now: () => new Date("2026-08-10T04:17:23.456Z"),
		...overrides,
	};
}

describe("replicate backup", () => {
	test("writes a dated, parseable snapshot and returns its summary", async () => {
		const ctx = await fixture();
		const result = await runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir));
		expect(basename(result.file)).toBe("data.target-target.20260810-041723Z.snapshot.json");
		const snapshot = parseSnapshot(readFileSync(result.file, "utf8"));
		expect(result.digest).toBe(snapshot.digest);
		expect(result.items).toBe(1);
		expect(result.archived).toBe(0);
		expect(result.fresh).toBeTrue();
		expect(result.kept).toBe(1);
	});

	test("the injectable clock controls both filename and takenAt", async () => {
		const ctx = await fixture();
		const result = await runBackup(
			ctx.client,
			{ projectId: ctx.projectId },
			options(ctx.dir, { now: () => new Date("2031-12-03T01:02:03Z") }),
		);
		expect(basename(result.file)).toBe("data.target-target.20311203-010203Z.snapshot.json");
		expect(parseSnapshot(readFileSync(result.file, "utf8")).takenAt).toBe(
			"2031-12-03T01:02:03.000Z",
		);
	});

	test("snapshot failure leaves no new or temporary file and does not prune", async () => {
		const ctx = await fixture();
		const old = join(ctx.dir, "data.target-target.20200101-000000Z.snapshot.json");
		writeFileSync(old, "old");
		ctx.client.failNextGetProject = new PlaneApiError("boom", 503);
		await expect(
			runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir, { retain: 1 })),
		).rejects.toThrow("boom");
		expect(readdirSync(ctx.dir)).toEqual([basename(old)]);
	});

	test("retention prunes only strict matches for this project", async () => {
		const ctx = await fixture();
		for (const name of [
			"data.target-target.20200101-000000Z.snapshot.json",
			"data.target-target.20210101-000000Z.snapshot.json",
			"data.target-target.20220101-000000Z.snapshot.json",
			"other.20200101-000000Z.snapshot.json",
			"data.snapshot.json",
			"data.target-target.20200101-000000Z.snapshot.json.tmp-1",
			"data2.20200101-000000Z.snapshot.json",
			"data.extra.20200101-000000Z.snapshot.json",
			"DATA.20200101-000000Z.snapshot.json",
		])
			writeFileSync(join(ctx.dir, name), name);
		const result = await runBackup(
			ctx.client,
			{ projectId: ctx.projectId },
			options(ctx.dir, { retain: 2, checkFresh: false }),
		);
		expect(result.pruned.map((file) => basename(file))).toEqual([
			"data.target-target.20210101-000000Z.snapshot.json",
			"data.target-target.20200101-000000Z.snapshot.json",
		]);
		expect(result.kept).toBe(2);
		for (const untouched of [
			"other.20200101-000000Z.snapshot.json",
			"data.snapshot.json",
			"data.target-target.20200101-000000Z.snapshot.json.tmp-1",
			"data2.20200101-000000Z.snapshot.json",
			"data.extra.20200101-000000Z.snapshot.json",
			"DATA.20200101-000000Z.snapshot.json",
		])
			expect(readdirSync(ctx.dir)).toContain(untouched);
	});

	test("escapes regex metacharacters in an otherwise safe identifier", async () => {
		const ctx = await fixture();
		ctx.client.projects.get(ctx.projectId)!.identifier = "D.A.TA";
		const exact = "d.a.ta.target-target.20200101-000000Z.snapshot.json";
		const unescapedInterpretation = "dxayta.target-target.20200101-000000Z.snapshot.json";
		writeFileSync(join(ctx.dir, exact), exact);
		writeFileSync(join(ctx.dir, unescapedInterpretation), unescapedInterpretation);
		const result = await runBackup(
			ctx.client,
			{ projectId: ctx.projectId },
			options(ctx.dir, { retain: 1, checkFresh: false }),
		);
		expect(result.pruned.map((file) => basename(file))).toEqual([exact]);
		expect(readdirSync(ctx.dir)).toContain(unescapedInterpretation);
	});

	test("a backup of ANOTHER instance is never pruned, even in a shared directory", async () => {
		// The scenario this protects: after a cutover, two live boards share a project
		// identifier. A cron repointed at the new instance would otherwise prune the OLD
		// board's backups — the rollback copy — under its own retention rule. Directory
		// separation should not be the only thing preventing that.
		const ctx = await fixture();
		const otherInstance = [
			"data.cloud-acme.20200101-000000Z.snapshot.json",
			"data.cloud-acme.20210101-000000Z.snapshot.json",
			"data.cloud-acme.20220101-000000Z.snapshot.json",
		];
		// Legacy untagged files (written before source tagging) are left alone too,
		// rather than silently swept by a pattern they predate.
		const legacy = "data.20190101-000000Z.snapshot.json";
		for (const name of [...otherInstance, legacy]) writeFileSync(join(ctx.dir, name), name);
		const result = await runBackup(
			ctx.client,
			{ projectId: ctx.projectId },
			options(ctx.dir, { retain: 1, checkFresh: false }),
		);
		expect(result.pruned).toEqual([]);
		const remaining = readdirSync(ctx.dir);
		for (const name of [...otherInstance, legacy]) expect(remaining).toContain(name);
	});

	test("retention attempts every deletion and aggregates failures", async () => {
		const ctx = await fixture();
		const undeletable = "data.target-target.20200101-000000Z.snapshot.json";
		const deletable = "data.target-target.20210101-000000Z.snapshot.json";
		mkdirSync(join(ctx.dir, undeletable));
		writeFileSync(join(ctx.dir, deletable), deletable);
		try {
			await runBackup(
				ctx.client,
				{ projectId: ctx.projectId },
				options(ctx.dir, { retain: 1, checkFresh: false }),
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ReplicateError);
			expect(String(error)).toContain("Backup succeeded");
			expect(String(error)).toContain(undeletable);
		}
		expect(readdirSync(ctx.dir)).not.toContain(deletable);
	});

	test("freshness detects a mutation, while disabling it makes no extra list calls", async () => {
		const stale = await fixture();
		let liveLists = 0;
		const originalList = stale.client.listWorkItems.bind(stale.client);
		stale.client.listWorkItems = async <T>(projectId: string): Promise<T[]> => {
			liveLists++;
			const rows = await originalList<T>(projectId);
			if (liveLists === 2) (rows[0] as { updated_at: string }).updated_at = "2030-01-01T00:00:00Z";
			return rows;
		};
		const staleResult = await runBackup(
			stale.client,
			{ projectId: stale.projectId },
			options(stale.dir),
		);
		expect(staleResult.fresh).toBeFalse();
		expect(staleResult.freshnessNotes.length).toBeGreaterThan(0);
		expect(readFileSync(staleResult.file, "utf8")).toContain('"digest"');

		const skipped = await fixture();
		let skippedLists = 0;
		const skippedOriginal = skipped.client.listWorkItems.bind(skipped.client);
		skipped.client.listWorkItems = async <T>(projectId: string): Promise<T[]> => {
			skippedLists++;
			return skippedOriginal<T>(projectId);
		};
		const skippedResult = await runBackup(
			skipped.client,
			{ projectId: skipped.projectId },
			options(skipped.dir, { checkFresh: false }),
		);
		expect(skippedResult.fresh).toBeNull();
		expect(skippedLists).toBe(1);
	});

	test("same-second collision preserves the existing file", async () => {
		const ctx = await fixture();
		const first = await runBackup(
			ctx.client,
			{ projectId: ctx.projectId },
			options(ctx.dir, { checkFresh: false }),
		);
		const content = readFileSync(first.file, "utf8");
		await expect(
			runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir, { checkFresh: false })),
		).rejects.toBeInstanceOf(ReplicateError);
		expect(readFileSync(first.file, "utf8")).toBe(content);
	});

	test("concurrent same-second publication atomically preserves one backup", async () => {
		const ctx = await fixture();
		const settled = await Promise.allSettled([
			runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir, { checkFresh: false })),
			runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir, { checkFresh: false })),
		]);
		expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = settled.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(ReplicateError);
		const file = join(ctx.dir, "data.target-target.20260810-041723Z.snapshot.json");
		expect(parseSnapshot(readFileSync(file, "utf8")).project.identifier).toBe("DATA");
		expect(readdirSync(ctx.dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	test("rejects an identifier that could escape the backup directory", async () => {
		const ctx = await fixture();
		ctx.client.projects.get(ctx.projectId)!.identifier = "../escape";
		await expect(
			runBackup(ctx.client, { projectId: ctx.projectId }, options(ctx.dir)),
		).rejects.toBeInstanceOf(ReplicateError);
		expect(readdirSync(ctx.dir)).toEqual([]);
		expect(readdirSync(join(ctx.dir, ".."))).not.toContain("escape.20260810-041723Z.snapshot.json");
	});

	test("invalid retention fails before any network call", async () => {
		for (const retain of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			let calls = 0;
			const client = new Proxy({} as FakePlane, {
				get() {
					calls++;
					throw new Error("network accessed");
				},
			});
			await expect(
				runBackup(client, { projectId: "p" }, options("unused", { retain })),
			).rejects.toBeInstanceOf(ReplicateError);
			expect(calls).toBe(0);
		}
	});
});
