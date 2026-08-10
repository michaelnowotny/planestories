import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApplyOptions, applySnapshot } from "../../../src/replicate/apply.ts";
import { Journal } from "../../../src/replicate/journal.ts";
import { computeSnapshotDigest } from "../../../src/replicate/snapshot.ts";
import { verifySnapshot } from "../../../src/replicate/verify.ts";
import { type FakeItem, FakePlane } from "./fake-plane.ts";
import { sampleSnapshot } from "./fixtures.ts";

const flags = {
	allowSqlFinalize: false,
	noExactIdentifiers: false,
	assumeGapsDeleted: false,
	recreateTarget: false,
};

async function applied(configure?: (fake: FakePlane) => void) {
	const dir = mkdtempSync(join(tmpdir(), "planestories-verify-"));
	const fake = new FakePlane();
	configure?.(fake);
	const snapshot = sampleSnapshot();
	const journalPath = join(dir, "apply.jsonl");
	const options = {
		yes: true,
		flags,
		journalPath,
		toolVersion: "test",
		runId: "verify-test",
		sleep: async () => {},
	} satisfies ApplyOptions;
	await applySnapshot(fake, snapshot, options);
	return {
		dir,
		fake,
		snapshot,
		journalPath,
		project: fake.projectByIdentifier("SRC")!,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

async function appliedNoArchived() {
	// The cloud/CE reality for the DATA rehearsal: NEITHER side serves the
	// archived-items endpoint, and the snapshot contains no archived items.
	const dir = mkdtempSync(join(tmpdir(), "planestories-verify-"));
	const fake = new FakePlane();
	fake.archivedEndpointAvailable = false;
	const snapshot = sampleSnapshot();
	for (const item of snapshot.items) item.archived = false;
	snapshot.source.archivedInventory = "unavailable";
	snapshot.digest = computeSnapshotDigest(snapshot);
	const journalPath = join(dir, "apply.jsonl");
	await applySnapshot(fake, snapshot, {
		yes: true,
		flags: { ...flags, assumeGapsDeleted: true },
		journalPath,
		toolVersion: "test",
		runId: "verify-test",
		sleep: async () => {},
	});
	return {
		dir,
		fake,
		snapshot,
		journalPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("replicate verify", () => {
	test("runs live-only with a warning when nothing was archived and the endpoint is absent", async () => {
		// Hard-refusing here would make verify unusable against the actual
		// acceptance target (the operator's CE serves no archived endpoint).
		// With zero archived items in snapshot AND journal, live-only equality
		// is provable except for a foreign post-apply archived item — which is
		// exactly what the warning states.
		const ctx = await appliedNoArchived();
		try {
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(report.summary.failures).toBe(0);
			expect(report.summary.ok).toBeTrue();
			expect(
				report.findings.some(
					(finding) => finding.severity === "warning" && /live-only/.test(finding.message),
				),
			).toBeTrue();
		} finally {
			ctx.cleanup();
		}
	});

	test("footer comments survive a data-attribute-stripping target (marker gone, text kept)", async () => {
		// Grok P3 finding 1: when timestamps are NOT natively accepted, comments
		// match by the data-psrepl marker — which a sanitizing target strips
		// while KEEPING the visible provenance text. Verify must fall back to
		// content matching and strip the footer by text shape, or a legitimate
		// apply bricks verification.
		const ctx = await applied((fake) => {
			fake.acceptCreatedAt = false;
			fake.sanitizeCommentHtml = true;
		});
		try {
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(
				report.findings.filter(
					(finding) => finding.check === "comments" && finding.severity === "failure",
				),
			).toEqual([]);
		} finally {
			ctx.cleanup();
		}
	});

	test("a null-created_at source comment with a native author still matches", async () => {
		// Grok P3 finding 2: native-author path writes no footer and no
		// created_at when the source comment has none — verify then had no
		// durable key at all and reported a false authorship/match failure.
		const dir = mkdtempSync(join(tmpdir(), "planestories-verify-"));
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		const item1 = snapshot.items.find((item) => item.sequenceId === 1)!;
		snapshot.comments[item1.id] = [
			{
				id: "comment-no-instant",
				commentHtml: "<p>timeless native comment</p>",
				createdAt: null,
				createdBy: "source-mapped",
			},
		];
		snapshot.digest = computeSnapshotDigest(snapshot);
		const journalPath = join(dir, "apply.jsonl");
		try {
			await applySnapshot(fake, snapshot, {
				yes: true,
				flags,
				journalPath,
				toolVersion: "test",
				runId: "verify-test",
				sleep: async () => {},
			});
			const report = await verifySnapshot(fake, snapshot, { journalPath });
			expect(
				report.findings.filter(
					(finding) =>
						(finding.check === "comments" || finding.check === "authorship") &&
						finding.severity === "failure",
				),
			).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("state name casing differences warn instead of failing (C5)", async () => {
		const ctx = await applied();
		try {
			for (const state of ctx.project.states.values()) {
				state.name = state.name.toUpperCase();
			}
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(
				report.findings.filter(
					(finding) => finding.check === "state" && finding.severity === "failure",
				),
			).toEqual([]);
			expect(
				report.findings.some(
					(finding) => finding.check === "state" && /casing/.test(finding.message),
				),
			).toBeTrue();
		} finally {
			ctx.cleanup();
		}
	});

	test("rejects a journal whose comment mapping is not one-to-one (X2)", async () => {
		const ctx = await applied();
		try {
			// Forge a second source comment mapped to an ALREADY-USED target id.
			const journal = Journal.open(ctx.journalPath, {
				snapshotDigest: ctx.snapshot.digest,
				targetBaseUrl: ctx.fake.baseUrl,
				targetWorkspaceSlug: ctx.fake.workspaceSlug,
			});
			const existing = journal.entries.find(
				(entry): entry is Extract<(typeof journal.entries)[number], { type: "comment-created" }> =>
					entry.type === "comment-created",
			)!;
			journal.append({
				type: "comment-created",
				sourceCommentId: "forged-source",
				targetCommentId: existing.targetCommentId,
			});
			journal.close();
			await expect(
				verifySnapshot(ctx.fake, ctx.snapshot, { journalPath: ctx.journalPath }),
			).rejects.toThrow(/one-to-one/);
		} finally {
			ctx.cleanup();
		}
	});

	test("a native comment whose real content ends footer-shaped is not mutilated (X3)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "planestories-verify-"));
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		const item1 = snapshot.items.find((item) => item.sequenceId === 1)!;
		snapshot.comments[item1.id] = [
			{
				id: "comment-footerish",
				commentHtml:
					"<p>real content</p><p><em>— replicated from LEGACY; original author Bob, 2020-01-01</em></p>",
				createdAt: "2024-01-01T00:00:00Z",
				createdBy: "source-mapped", // native path: apply writes NO footer
			},
		];
		snapshot.digest = computeSnapshotDigest(snapshot);
		const journalPath = join(dir, "apply.jsonl");
		try {
			await applySnapshot(fake, snapshot, {
				yes: true,
				flags,
				journalPath,
				toolVersion: "test",
				runId: "verify-test",
				sleep: async () => {},
			});
			const report = await verifySnapshot(fake, snapshot, { journalPath });
			expect(
				report.findings.filter(
					(finding) => finding.check === "comments" && finding.severity === "failure",
				),
			).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("state GROUP differences are failures even when only casing differs (X4)", async () => {
		const ctx = await applied();
		try {
			for (const state of ctx.project.states.values()) {
				if (state.name === "Backlog") state.group = "Backlog".toUpperCase();
			}
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(
				report.findings.some(
					(finding) =>
						finding.check === "state" &&
						finding.severity === "failure" &&
						/group/i.test(finding.message),
				),
			).toBeTrue();
		} finally {
			ctx.cleanup();
		}
	});

	test("still refuses live-only verify when the snapshot carries archived items", async () => {
		const ctx = await applied((fake) => {
			fake.archivedEndpointAvailable = false;
		});
		try {
			await expect(
				verifySnapshot(ctx.fake, ctx.snapshot, { journalPath: ctx.journalPath }),
			).rejects.toThrow(/archived/);
		} finally {
			ctx.cleanup();
		}
	});

	test("a clean apply has zero failures and strips provenance footers", async () => {
		const ctx = await applied();
		try {
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(report.summary.failures).toBe(0);
			expect(report.summary.ok).toBeTrue();
			expect(report.findings.some((finding) => finding.check === "comments")).toBeFalse();
		} finally {
			ctx.cleanup();
		}
	});

	test("detects every target mutation class", async () => {
		const cases: Array<{
			name: string;
			mutate: (ctx: Awaited<ReturnType<typeof applied>>) => void;
			check: string;
			message?: RegExp;
		}> = [
			{
				name: "renamed item",
				mutate: ({ project }) => {
					itemAt(project, 1).name = "Renamed";
				},
				check: "scalar-fields",
				message: /name/,
			},
			{
				name: "missing item",
				mutate: ({ project }) => {
					project.items.delete(itemAt(project, 1).id);
				},
				check: "set-equality",
				message: /missing/,
			},
			{
				name: "extra item",
				mutate: ({ project }) => {
					project.items.set("extra", {
						id: "extra",
						sequence_id: 99,
						name: "Extra",
						archived_at: null,
					});
				},
				check: "set-equality",
				message: /Extra/,
			},
			{
				name: "wrong state group",
				mutate: ({ project }) => {
					const state = project.states.get(String(itemAt(project, 1).state))!;
					state.group = "completed";
				},
				check: "state",
				message: /group/,
			},
			{
				name: "label set",
				mutate: ({ project }) => {
					itemAt(project, 1).labels = [];
				},
				check: "labels",
			},
			{
				name: "parent",
				mutate: ({ project }) => {
					itemAt(project, 3).parent = null;
				},
				check: "parent",
			},
			{
				name: "date",
				mutate: ({ project }) => {
					itemAt(project, 1).start_date = "2030-01-01";
				},
				check: "scalar-fields",
				message: /start_date/,
			},
			{
				name: "point",
				mutate: ({ project }) => {
					itemAt(project, 1).point = 88;
				},
				check: "scalar-fields",
				message: /point/,
			},
			{
				name: "external id",
				mutate: ({ project }) => {
					itemAt(project, 1).external_id = "drift";
				},
				check: "scalar-fields",
				message: /external_id/,
			},
			{
				name: "archived flag",
				mutate: ({ project }) => {
					itemAt(project, 5).archived_at = null;
				},
				check: "scalar-fields",
				message: /archived/,
			},
			{
				name: "comment count",
				mutate: ({ project }) => {
					project.comments.set(itemAt(project, 1).id, []);
				},
				check: "comments",
				message: /count/,
			},
			{
				name: "comment content",
				mutate: ({ project }) => {
					project.comments.get(itemAt(project, 1).id)![0]!.comment_html = "<p>changed</p>";
				},
				check: "comments",
			},
			{
				name: "relation",
				mutate: ({ project }) => {
					project.relations.pop();
				},
				check: "relations",
			},
			{
				name: "sequence",
				mutate: ({ project }) => {
					itemAt(project, 1).sequence_id = 42;
				},
				check: "set-equality",
				message: /Sequence/,
			},
		];
		for (const entry of cases) {
			const ctx = await applied();
			try {
				entry.mutate(ctx);
				const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
					journalPath: ctx.journalPath,
				});
				const matching = report.findings.filter(
					(finding) => finding.severity === "failure" && finding.check === entry.check,
				);
				expect(matching.length, entry.name).toBeGreaterThan(0);
				if (entry.message) {
					expect(
						matching.some((finding) => entry.message!.test(finding.message)),
						entry.name,
					).toBeTrue();
				}
			} finally {
				ctx.cleanup();
			}
		}
	});

	test("markup-only description changes are warnings, not failures", async () => {
		const ctx = await applied();
		try {
			itemAt(ctx.project, 1).description_html = '<p class="normalized">Description 1</p>';
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(report.summary.failures).toBe(0);
			expect(
				report.findings.some(
					(finding) => finding.check === "description" && finding.severity === "warning",
				),
			).toBeTrue();
		} finally {
			ctx.cleanup();
		}
	});

	test("rejected relations warn and rejected created_at fields are explicitly skipped", async () => {
		const ctx = await applied((fake) => {
			fake.acceptCreatedAt = false;
			fake.rejectedRelationKinds.add("start_before");
		});
		try {
			const report = await verifySnapshot(ctx.fake, ctx.snapshot, {
				journalPath: ctx.journalPath,
			});
			expect(report.summary.failures).toBe(0);
			expect(
				report.findings.some((finding) => /Known degradation/.test(finding.message)),
			).toBeTrue();
			expect(report.skipped.some((entry) => entry.field === "item.created_at")).toBeTrue();
			expect(report.skipped.some((entry) => entry.field === "comment.created_at")).toBeTrue();
		} finally {
			ctx.cleanup();
		}
	});

	test("audits source-host links and cross-checks an export file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "planestories-verify-assets-"));
		const fake = new FakePlane();
		const snapshot = sampleSnapshot();
		snapshot.items[0]!.descriptionHtml =
			'<p><img src="https://source.example.test/a.png"><a href="https://other.test">x</a></p>';
		snapshot.digest = computeSnapshotDigest(snapshot);
		const journalPath = join(dir, "apply.jsonl");
		try {
			await applySnapshot(fake, snapshot, {
				yes: true,
				flags,
				journalPath,
				toolVersion: "test",
				runId: "assets",
				sleep: async () => {},
			});
			const exportFile = join(dir, "export.md");
			writeFileSync(exportFile, "## Item 1\n```yaml\nplane_identifier: SRC-1\n```\nbody\n");
			const happy = await verifySnapshot(fake, snapshot, { journalPath, exportFile });
			// A one-story export of a five-item board: no absence/title findings,
			// only the advisory partial-coverage note.
			const happyExport = happy.findings.filter((finding) => finding.check === "export-file");
			expect(happyExport).toHaveLength(1);
			expect(happyExport[0]?.message).toContain("not present in the export file");
			writeFileSync(exportFile, "## Wrong title\n```yaml\nplane_identifier: SRC-1\n```\nbody\n");
			const report = await verifySnapshot(fake, snapshot, { journalPath, exportFile });
			expect(report.counts.assets.sourceInstance).toBe(1);
			expect(report.counts.assets.other).toBe(1);
			expect(report.findings.some((finding) => finding.check === "asset-links")).toBeTrue();
			expect(report.findings.some((finding) => finding.check === "export-file")).toBeTrue();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function itemAt(project: { items: Map<string, FakeItem> }, sequence: number): FakeItem {
	return [...project.items.values()].find((item) => item.sequence_id === sequence)!;
}
