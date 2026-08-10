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
