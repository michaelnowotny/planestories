import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaneApiError } from "../../../src/errors.ts";
import { type ApplyOptions, applySnapshot } from "../../../src/replicate/apply.ts";
import { Journal } from "../../../src/replicate/journal.ts";
import { computeSnapshotDigest } from "../../../src/replicate/snapshot.ts";
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

	test("--recreate-target must NOT delete a destination that has diverged", async () => {
		// The critical case: after a cutover the destination is authoritative and has
		// accumulated work the snapshot never saw. --recreate-target is the flag the
		// docs point an operator at for recovery, and it is the ONLY apply path that
		// destroys destination-only work. The guard therefore has to run BEFORE the
		// delete, on live state — checking afterwards is checking a world we already
		// destroyed. A gate-level test cannot see that ordering; this one can.
		const ctx = context();
		const fake = new FakePlane();
		try {
			// First, a complete apply so the journal legitimately owns the destination.
			await applySnapshot(fake, sampleSnapshot(), ctx.options);
			const project = fake.projectByIdentifier("SRC")!;
			// Then the destination accumulates work of its own.
			project.items.set("dest-only", {
				id: "dest-only",
				sequence_id: 9001,
				name: "work done on the destination after cutover",
				archived_at: null,
			} as never);
			const deletedBefore = fake.deletedProjects.length;

			await expect(
				applySnapshot(fake, sampleSnapshot(), {
					...ctx.options,
					flags: { ...baseFlags, recreateTarget: true },
				}),
			).rejects.toThrow(/9001|diverged|never seen/i);

			// The refusal must happen BEFORE any destruction.
			expect(fake.deletedProjects.length).toBe(deletedBefore);
			expect(fake.projectByIdentifier("SRC")).toBeDefined();
			expect(fake.projectByIdentifier("SRC")!.items.has("dest-only")).toBe(true);
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
			// The destination now holds a foreign item, so --recreate-target ALONE is
			// refused: content cannot distinguish "a stray item planted mid-run" from
			// "a week of work someone did on the destination", and the destructive
			// flag must not decide that on the operator's behalf.
			await expect(
				applySnapshot(fake, sampleSnapshot(), {
					...ctx.options,
					flags: { ...baseFlags, recreateTarget: true },
				}),
			).rejects.toThrow(/diverged|never seen/i);
			// Acknowledging the divergence explicitly recovers.
			const result = await applySnapshot(fake, sampleSnapshot(), {
				...ctx.options,
				flags: { ...baseFlags, recreateTarget: true, allowDivergentTarget: true },
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

	test("sequence drift never journals item-created for the drifted number", async () => {
		// Poisoning must be the FIRST durable fact about a drifted create. If
		// item-created lands first and the process dies before the poison line,
		// resume would treat the drifted item as legitimately owning that
		// sequence and silently continue building on a mis-numbered board.
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
			const journal = readFileSync(ctx.options.journalPath, "utf8");
			expect(journal).toContain('"type":"poisoned"');
			expect(journal).not.toContain('"sourceItemId":"source-3","targetItemId"');
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("adopts an orphan destination project whose ambiguous create committed", async () => {
		// Crash window: createProject committed server-side but the journal never
		// recorded ownership. The orphan holds the identifier; without adoption
		// the gate would refuse it forever and --recreate-target could not delete
		// what the journal does not own — a manual-recovery dead end.
		const ctx = context();
		const fake = new FakePlane();
		fake.failProjectCreateCommittedFor = "SRC";
		const snapshot = sampleSnapshot();
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/ambiguous/);
			const resumed = await applySnapshot(fake, snapshot, ctx.options);
			expect(resumed.complete).toBeTrue();
			// The orphan was adopted, not duplicated: exactly one SRC project.
			expect(
				[...fake.projects.values()].filter((project) => project.identifier === "SRC"),
			).toHaveLength(1);
			expect(
				[...fake.projectByIdentifier("SRC")!.items.values()].map((item) => item.sequence_id).sort(),
			).toEqual([1, 3, 5, 6, 7]);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("refuses to adopt a same-name project whose only items are archived", async () => {
		// The zero-items fingerprint must include the ARCHIVED inventory: a
		// foreign project can look empty on the live list while holding archived
		// history that adoption would silently mutate and --recreate-target
		// would later delete.
		const ctx = context();
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		fake.failProjectCreateCommittedFor = "SRC";
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/ambiguous/);
			// Plant archived history in the orphan before the resume.
			const orphan = fake.projectByIdentifier("SRC")!;
			const ghost = await fake.createWorkItem<{ id: string }>(orphan.id, { name: "history" });
			await fake.archiveWorkItem(orphan.id, ghost.id);
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/Refusing to adopt/);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("comment adoption fails closed when two source comments share a timestamp", async () => {
		// created_at is only a durable adoption key while it is UNIQUE among the
		// item's comments. With a duplicate timestamp, adopting "whichever
		// matched first" could journal the WRONG comment as created and silently
		// swallow the other.
		const ctx = context();
		const fake = new FakePlane();
		fake.sanitizeCommentHtml = true;
		const snapshot = sampleSnapshot();
		const item1 = snapshot.items.find((item) => item.sequenceId === 1)!;
		snapshot.comments[item1.id] = [
			{
				id: "comment-dup-a",
				commentHtml: "<p>first twin</p>",
				createdAt: "2024-03-03T03:03:03Z",
				createdBy: "source-missing",
			},
			{
				id: "comment-dup-b",
				commentHtml: "<p>second twin</p>",
				createdAt: "2024-03-03T03:03:03Z",
				createdBy: "source-missing",
			},
		];
		snapshot.digest = computeSnapshotDigest(snapshot);
		fake.failCommentCreateCommittedMatch = "second twin";
		fake.failCommentListMatch = "second twin";
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/ambiguous/);
			// Resume: created_at matches BOTH twins; the surviving content prefix
			// disambiguates → correct adoption, no duplicate, no guess.
			const resumed = await applySnapshot(fake, snapshot, ctx.options);
			expect(resumed.complete).toBeTrue();
			const allComments = [...fake.projectByIdentifier("SRC")!.comments.values()].flat();
			expect(allComments).toHaveLength(3);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("comment adoption fails closed on truly indistinguishable twins", async () => {
		// Same created_at AND same content: no field can say which stored
		// comment is which source comment — guessing could journal the wrong
		// one as created and silently swallow its sibling.
		const ctx = context();
		const fake = new FakePlane();
		fake.sanitizeCommentHtml = true;
		const snapshot = sampleSnapshot();
		const item1 = snapshot.items.find((item) => item.sequenceId === 1)!;
		snapshot.comments[item1.id] = [
			{
				id: "comment-clone-a",
				commentHtml: "<p>identical clone</p>",
				createdAt: "2024-03-03T03:03:03Z",
				createdBy: "source-missing",
			},
			{
				id: "comment-clone-b",
				commentHtml: "<p>identical clone</p>",
				createdAt: "2024-03-03T03:03:03Z",
				createdBy: "source-missing",
			},
		];
		snapshot.digest = computeSnapshotDigest(snapshot);
		fake.failCommentCreateCommittedMatch = "identical clone";
		fake.failCommentCreateCommittedSkip = 1; // first clone lands; the SECOND is ambiguous
		fake.failCommentListMatch = "identical clone";
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/ambiguous/);
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(
				/[Cc]annot distinguish/,
			);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("a stolen lock stops PLANE WRITES immediately, not just journal appends", async () => {
		// The append-time check alone is too late: states, labels, archive verbs
		// and --recreate-target's DELETE reach Plane BEFORE their next append.
		// Steal the lock during the states-phase READ; the very next operation is
		// a Plane write (createState) that must be refused pre-flight.
		const ctx = context();
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		let writesAtSteal = -1;
		const origListStates = fake.listStates.bind(fake);
		fake.listStates = async <T>(projectId: string): Promise<T[]> => {
			if (writesAtSteal === -1 && existsSync(`${ctx.options.journalPath}.lock`)) {
				writeFileSync(`${ctx.options.journalPath}.lock`, "99999999");
				writesAtSteal = fake.writeCalls;
			}
			return origListStates<T>(projectId);
		};
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/lock/);
			expect(writesAtSteal).toBeGreaterThan(-1);
			// Not a single Plane write landed after the steal.
			expect(fake.writeCalls).toBe(writesAtSteal);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("a journal holding only a torn header is discarded and the run proceeds fresh", async () => {
		// Crash during the very first header write leaves a file with zero
		// committed records. It holds no facts, so it must not brick the run
		// ("no valid header" + "already exists" with no flag that helps).
		const ctx = context();
		const fake = new FakePlane();
		try {
			writeFileSync(ctx.options.journalPath, '{"type":"header","runId":"torn'); // no newline
			const result = await applySnapshot(fake, sampleSnapshot(), ctx.options);
			expect(result.complete).toBeTrue();
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("comment adoption survives a target that rewrites HTML on save", async () => {
		// A sanitizing target strips data-* attributes — including the footer's
		// idempotency marker. Crash window: the FOOTER comment's create commits,
		// the reconciling list dies, the run dies. On resume the marker is gone
		// from the stored HTML; adoption must fall back to the natively preserved
		// created_at or it re-POSTs a duplicate.
		const ctx = context();
		const fake = new FakePlane();
		fake.sanitizeCommentHtml = true;
		fake.failCommentCreateCommittedMatch = "footer";
		fake.failCommentListMatch = "footer";
		const snapshot = sampleSnapshot();
		try {
			await expect(applySnapshot(fake, snapshot, ctx.options)).rejects.toThrow(/ambiguous/);
			const resumed = await applySnapshot(fake, snapshot, ctx.options);
			expect(resumed.complete).toBeTrue();
			const allComments = [...fake.projectByIdentifier("SRC")!.comments.values()].flat();
			expect(allComments).toHaveLength(2); // one per source comment, no duplicates
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
