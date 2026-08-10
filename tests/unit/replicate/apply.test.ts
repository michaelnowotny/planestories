import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaneApiError } from "../../../src/errors.ts";
import { type ApplyOptions, applySnapshot } from "../../../src/replicate/apply.ts";
import { Journal } from "../../../src/replicate/journal.ts";
import { type FakeItem, FakePlane } from "./fake-plane.ts";
import { sampleSnapshot } from "./fixtures.ts";

const baseFlags = {
	allowSqlFinalize: false,
	noExactIdentifiers: false,
	assumeGapsDeleted: false,
	recreateTarget: false,
};

function context(overrides: Partial<ApplyOptions> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "planestories-apply-"));
	return {
		dir,
		options: {
			yes: true,
			flags: { ...baseFlags },
			journalPath: join(dir, "apply.jsonl"),
			toolVersion: "test",
			runId: "test-run",
			sleep: async () => {},
			...overrides,
		} satisfies ApplyOptions,
	};
}

describe("replication apply", () => {
	test("replicates exact identifiers, content phases, archive, and placeholder cleanup", async () => {
		const ctx = context();
		const fake = new FakePlane();
		fake.rejectedRelationKinds.add("start_before");
		try {
			const result = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(result.complete).toBeTrue();
			expect(result.mode).toBe("exact");
			expect(result.itemsCreated).toBe(5);
			expect(result.placeholdersCreated).toBe(2);
			expect(result.placeholdersDeleted).toBe(2);
			expect(result.parentsSet).toBe(1);
			expect(result.relationsCreated).toBe(2);
			expect(result.commentsCreated).toBe(2);
			expect(result.archivedCount).toBe(1);

			const project = fake.projectByIdentifier("SRC")!;
			const items = [...project.items.values()].sort((a, b) => a.sequence_id - b.sequence_id);
			expect(items.map((item) => item.sequence_id)).toEqual([1, 3, 5, 6, 7]);
			expect(items.map((item) => item.external_source)).toEqual([
				"source-system",
				"source-system",
				"source-system",
				"source-system",
				"source-system",
			]);
			expect(items.find((item) => item.sequence_id === 3)?.parent).toBe(
				items.find((item) => item.sequence_id === 1)?.id,
			);
			expect(items.find((item) => item.sequence_id === 5)?.archived_at).not.toBeNull();
			expect(project.relations).toHaveLength(2);
			expect([...project.labels.values()].find((label) => label.name === "Backend")?.parent).toBe(
				[...project.labels.values()].find((label) => label.name === "Area")?.id,
			);
			const comments = [...project.comments.values()].flat();
			expect(
				comments.some((comment) => comment.comment_html.includes("data-psrepl-comment")),
			).toBeTrue();
			expect(readFileSync(ctx.options.journalPath, "utf8")).toContain('"type":"apply-complete"');
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("resumes after an interrupted item intent without duplicating sequence numbers", async () => {
		const ctx = context();
		const fake = new FakePlane();
		let interrupted = false;
		fake.beforeCreate = (_projectId, body) => {
			if (!interrupted && body.name === "Item 3") {
				interrupted = true;
				throw new Error("simulated process death");
			}
		};
		try {
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				"simulated process death",
			);
			fake.beforeCreate = undefined;
			const result = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(result.complete).toBeTrue();
			const project = fake.projectByIdentifier("SRC")!;
			expect([...project.items.values()].map((item) => item.sequence_id).sort()).toEqual([
				1, 3, 5, 6, 7,
			]);
			expect(project.maxEver).toBe(7);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("adopts an intent whose ambiguous write committed before the resume", async () => {
		const ctx = context({ limit: 1 });
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		try {
			const paused = await applySnapshot(fake, snapshot, ctx.options);
			expect(paused.complete).toBeFalse();
			const project = fake.projectByIdentifier("SRC")!;
			const journal = Journal.open(ctx.options.journalPath, {
				snapshotDigest: snapshot.digest,
				targetBaseUrl: fake.baseUrl,
				targetWorkspaceSlug: fake.workspaceSlug,
			});
			journal.append({ type: "item-intent", seq: 2, sourceItemId: null });
			await fake.createWorkItem(project.id, { name: "planestories:placeholder:test-run:2" });
			journal.close();
			const before = fake.createCalls;
			const result = await applySnapshot(fake, snapshot, { ...ctx.options, limit: undefined });
			expect(result.complete).toBeTrue();
			expect(fake.createCalls - before).toBe(5);
			expect([...project.items.values()].map((item) => item.sequence_id).sort()).toEqual([
				1, 3, 5, 6, 7,
			]);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("poisons on sequence drift and only recreate-target can recover", async () => {
		const ctx = context();
		const fake = new FakePlane();
		fake.beforeCreate = (_projectId, body) => {
			if (body.name !== "Item 3") return;
			fake.beforeCreate = undefined;
			const project = fake.projectByIdentifier("SRC")!;
			project.maxEver++;
			const stolen: FakeItem = {
				id: "foreign-stolen",
				sequence_id: project.maxEver,
				name: "foreign concurrent item",
				archived_at: null,
			};
			project.items.set(stolen.id, stolen);
		};
		try {
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				/Sequence drift/,
			);
			expect(readFileSync(ctx.options.journalPath, "utf8")).toContain('"type":"poisoned"');
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				/--recreate-target/,
			);
			const result = await applySnapshot(fake, sampleSnapshot(), {
				...ctx.options,
				flags: { ...baseFlags, recreateTarget: true },
			});
			expect(result.complete).toBeTrue();
			expect(
				[...fake.projectByIdentifier("SRC")!.items.values()].map((item) => item.sequence_id).sort(),
			).toEqual([1, 3, 5, 6, 7]);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("cleanup-started is a one-way latch that forbids missing item creation", async () => {
		const ctx = context({ limit: 1 });
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		try {
			await applySnapshot(fake, snapshot, ctx.options);
			const journal = Journal.open(ctx.options.journalPath, {
				snapshotDigest: snapshot.digest,
				targetBaseUrl: fake.baseUrl,
				targetWorkspaceSlug: fake.workspaceSlug,
			});
			journal.append({ type: "cleanup-started" });
			journal.close();
			await expect(
				applySnapshot(fake, snapshot, { ...ctx.options, limit: undefined }),
			).rejects.toThrow(/item creation can never resume/);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("cleanup resumes idempotently after an ambiguous committed placeholder delete", async () => {
		const ctx = context();
		const fake = new FakePlane();
		fake.failNextPlaceholderDeleteCommitted = true;
		try {
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				"ambiguous delete committed",
			);
			expect(readFileSync(ctx.options.journalPath, "utf8")).toContain('"type":"cleanup-started"');
			const createCalls = fake.createCalls;
			const resumed = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(resumed.complete).toBeTrue();
			expect(resumed.placeholdersDeleted).toBe(2);
			expect(fake.createCalls).toBe(createCalls);
			expect(
				[...fake.projectByIdentifier("SRC")!.items.values()].map((item) => item.sequence_id).sort(),
			).toEqual([1, 3, 5, 6, 7]);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("dry-run performs no writes and creates no journal", async () => {
		const ctx = context({ yes: false });
		const fake = new FakePlane();
		fake.throwOnEveryWrite = true;
		try {
			const result = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(result.dryRun).toBeTrue();
			expect(fake.writeCalls).toBe(0);
			expect(existsSync(ctx.options.journalPath)).toBeFalse();
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("limit pauses after two serial creates and a rerun finishes", async () => {
		const ctx = context({ limit: 2 });
		const fake = new FakePlane();
		try {
			const paused = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(paused.complete).toBeFalse();
			expect(paused.itemsCreated).toBe(1);
			expect(paused.placeholdersCreated).toBe(1);
			const finished = await applySnapshot(fake, sampleSnapshot(), {
				...ctx.options,
				limit: undefined,
			});
			expect(finished.complete).toBeTrue();
			expect(fake.projectByIdentifier("SRC")!.maxEver).toBe(7);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("light verification failure never journals apply-complete", async () => {
		const ctx = context();
		const fake = new FakePlane();
		fake.vanishSequenceBeforeList = 1;
		try {
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				/Light verification failed/,
			);
			expect(readFileSync(ctx.options.journalPath, "utf8")).not.toContain(
				'"type":"apply-complete"',
			);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("a transient failure verifying the owned project surfaces without poisoning the journal", async () => {
		// A 429/5xx that outlives the client's retries during resume is a REAL
		// transient condition, not evidence the project is gone. Poisoning would
		// force --recreate-target — deleting a perfectly good destination — over
		// a network blip. Only a 404 or an identifier mismatch may poison.
		const ctx = context({ limit: 1 });
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		try {
			const paused = await applySnapshot(fake, snapshot, ctx.options);
			expect(paused.complete).toBeFalse();
			fake.failNextGetProject = new PlaneApiError("upstream overloaded", 503);
			await expect(
				applySnapshot(fake, snapshot, { ...ctx.options, limit: undefined }),
			).rejects.toThrow(/upstream overloaded/);
			expect(readFileSync(ctx.options.journalPath, "utf8")).not.toContain('"type":"poisoned"');
			const recovered = await applySnapshot(fake, snapshot, { ...ctx.options, limit: undefined });
			expect(recovered.complete).toBeTrue();
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("a gate-failed fresh run leaves no journal, so its own suggested rerun works", async () => {
		// The gate's error message tells the operator to re-run with
		// --no-exact-identifiers. If the failed run had already created a journal
		// pinning identifierMode "exact", that exact rerun would die on a resume
		// mode mismatch — the tool would block its own recovery instruction.
		const ctx = context();
		const fake = new FakePlane();
		fake.sequenceReuse = true;
		try {
			await expect(applySnapshot(fake, sampleSnapshot(), ctx.options)).rejects.toThrow(
				/--no-exact-identifiers/,
			);
			expect(existsSync(ctx.options.journalPath)).toBeFalse();
			const rerun = await applySnapshot(fake, sampleSnapshot(), {
				...ctx.options,
				flags: { ...baseFlags, noExactIdentifiers: true },
			});
			expect(rerun.complete).toBeTrue();
			expect(rerun.mode).toBe("renumber");
			// Renumber mode packs the 5 real items contiguously — no placeholders.
			expect(
				[...fake.projectByIdentifier("SRC")!.items.values()].map((item) => item.sequence_id).sort(),
			).toEqual([1, 2, 3, 4, 5]);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});
});
