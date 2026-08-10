import { describe, expect, test } from "bun:test";
import { checkFreshness } from "../../../src/replicate/freshness.ts";
import { sampleSnapshot } from "./fixtures.ts";

interface Row {
	id: string;
	sequence_id: number;
	updated_at: string | null;
}

function source(archivedAvailable = true) {
	const snapshot = sampleSnapshot();
	const live = snapshot.items.filter((item) => !item.archived).map(row);
	const archived = snapshot.items.filter((item) => item.archived).map(row);
	return {
		dialect: snapshot.source.dialect,
		live,
		archived,
		async listWorkItems<T>(): Promise<T[]> {
			return this.live as T[];
		},
		async listWorkItemComments<T>(): Promise<T[]> {
			return [] as T[];
		},
		async getRelations() {
			return {
				blocking: [],
				blocked_by: [],
				relates_to: [],
				duplicate: [],
				start_before: [],
				start_after: [],
				finish_before: [],
				finish_after: [],
			};
		},
		async listArchivedWorkItems<T>(): Promise<T[] | null> {
			return archivedAvailable ? (this.archived as T[]) : null;
		},
	};
}

describe("replicate freshness", () => {
	test("clean source passes", async () => {
		const snapshot = sampleSnapshot();
		expect((await checkFreshness(source(), snapshot)).fresh).toBeTrue();
	});

	test("added, deleted, and edited items are each detected", async () => {
		const snapshot = sampleSnapshot();
		const added = source();
		added.live.push({ id: "added", sequence_id: 9, updated_at: "2025-01-01T00:00:00Z" });
		expect((await checkFreshness(added, snapshot)).added).toHaveLength(1);

		const deleted = source();
		deleted.live.shift();
		expect((await checkFreshness(deleted, snapshot)).deleted).toHaveLength(1);

		const edited = source();
		edited.live[0]!.updated_at = "2025-01-01T00:00:00Z";
		expect((await checkFreshness(edited, snapshot)).drifted).toHaveLength(1);
	});

	test("an unavailable archived endpoint compares live items and records a note", async () => {
		const snapshot = sampleSnapshot();
		const report = await checkFreshness(source(false), snapshot);
		expect(report.fresh).toBeTrue();
		expect(report.notes[0]).toContain("Archived endpoint unavailable");
		expect(report.counts.comparableSnapshot).toBe(
			snapshot.items.filter((item) => !item.archived).length,
		);
	});
});

function row(item: ReturnType<typeof sampleSnapshot>["items"][number]): Row {
	return { id: item.id, sequence_id: item.sequenceId, updated_at: item.updatedAt };
}

describe("freshness --deep (Codex P3 finding 1)", () => {
	// Plane creates comments/relations WITHOUT bumping item updated_at, so the
	// item-level check is blind to them. --deep must see both; item-only mode
	// must SAY it cannot.
	const EMPTY = {
		blocking: [],
		blocked_by: [],
		relates_to: [],
		duplicate: [],
		start_before: [],
		start_after: [],
		finish_before: [],
		finish_after: [],
	};
	function deepClient(overrides: {
		comments?: Record<string, Array<{ id: string; comment_html: string }>>;
		relations?: Record<string, Record<string, string[]>>;
	}) {
		const snapshot = sampleSnapshot();
		return {
			snapshot,
			client: {
				dialect: snapshot.source.dialect,
				async listWorkItems<T>(): Promise<T[]> {
					return snapshot.items.filter((item) => !item.archived).map(row) as T[];
				},
				async listArchivedWorkItems<T>(): Promise<T[] | null> {
					return snapshot.items.filter((item) => item.archived).map(row) as T[];
				},
				async listWorkItemComments<T>(_p: string, itemId: string): Promise<T[]> {
					if (overrides.comments && itemId in overrides.comments) {
						return overrides.comments[itemId] as T[];
					}
					return (snapshot.comments[itemId] ?? []).map((comment) => ({
						id: comment.id,
						comment_html: comment.commentHtml,
					})) as T[];
				},
				async getRelations(_p: string, itemId: string) {
					if (overrides.relations && itemId in overrides.relations) {
						return { ...EMPTY, ...overrides.relations[itemId] };
					}
					return { ...EMPTY, ...(snapshot.relations[itemId] ?? {}) };
				},
			},
		};
	}

	test("item-only mode notes its comment/relation blindness", async () => {
		const ctx = deepClient({});
		const report = await checkFreshness(ctx.client, ctx.snapshot);
		expect(report.fresh).toBeTrue();
		expect(report.deep).toBeFalse();
		expect(report.notes.some((note) => /--deep/.test(note))).toBeTrue();
	});

	test("deep mode detects a comment-only edit the item timestamps cannot see", async () => {
		const ctx = deepClient({
			comments: { "source-1": [{ id: "comment-native", comment_html: "<p>EDITED</p>" }] },
		});
		const report = await checkFreshness(ctx.client, ctx.snapshot, { deep: true });
		expect(report.fresh).toBeFalse();
		expect(report.commentDrift).toHaveLength(1);
	});

	test("deep mode detects a relation-only change", async () => {
		const ctx = deepClient({ relations: { "source-1": {} } });
		const report = await checkFreshness(ctx.client, ctx.snapshot, { deep: true });
		expect(report.fresh).toBeFalse();
		expect(report.relationDrift.length).toBeGreaterThan(0);
	});
});
