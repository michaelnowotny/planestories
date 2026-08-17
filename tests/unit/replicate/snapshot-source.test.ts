import { describe, expect, test } from "bun:test";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { SnapshotSource } from "../../../src/replicate/snapshot_source.ts";
import { sampleSnapshot } from "./fixtures.ts";

/**
 * A snapshot already contains everything the read-only commands enumerate, so it can
 * stand in for the instance entirely — zero API calls, offline, and possible when the
 * instance is rate-limiting you. The contract that matters: what a command sees must be
 * IDENTICAL in shape to a live read, or the analysis silently differs from reality.
 */
describe("SnapshotSource", () => {
	const snapshot = sampleSnapshot();
	const source = new SnapshotSource(snapshot);

	test("the work-item index built from a snapshot matches a live read's shape", async () => {
		const index = await fetchProjectIndex(
			source as never,
			source.projectId,
			source.projectIdentifier,
		);
		expect(index.items.length).toBe(snapshot.items.length);
		for (const item of snapshot.items) {
			const normalized = index.byId.get(item.id);
			expect(normalized).toBeDefined();
			expect(normalized?.sequenceId).toBe(item.sequenceId);
			expect(normalized?.name).toBe(item.name);
		}
		// Identifiers must resolve, since every downstream check keys on them.
		const first = snapshot.items[0]!;
		expect(index.byIdentifier.get(`${source.projectIdentifier}-${first.sequenceId}`)?.id).toBe(
			first.id,
		);
	});

	test("state and labels are expanded, not left as raw ids", async () => {
		const rows = await source.listWorkItems<Record<string, unknown>>();
		const withState = rows.find((row) => row.state !== undefined);
		if (withState) {
			const state = withState.state as { name?: string; group?: string };
			expect(typeof state.name).toBe("string");
			expect(typeof state.group).toBe("string");
		}
		const withLabels = rows.find((row) => (row.labels as unknown[]).length > 0);
		if (withLabels) {
			const labels = withLabels.labels as Array<{ name?: string }>;
			expect(typeof labels[0]?.name).toBe("string");
		}
	});

	test("relations expand into the full Plane shape", async () => {
		const [itemId] = Object.keys(snapshot.relations);
		if (itemId) {
			const relations = await source.getRelations(source.projectId, itemId);
			expect(Array.isArray(relations.blocked_by)).toBe(true);
			expect(Array.isArray(relations.blocking)).toBe(true);
			expect(Array.isArray(relations.relates_to)).toBe(true);
		}
		// An item with no recorded relations answers with empty arrays, never undefined.
		const empty = await source.getRelations(source.projectId, "no-such-item");
		expect(empty.blocked_by).toEqual([]);
	});

	test("archived items are counted ONCE (they are already in the main listing)", async () => {
		const rows = await source.listWorkItems<{ id: string }>();
		const archived = await source.listArchivedWorkItems<{ id: string }>();
		// Not null — a snapshot always knows its archived inventory, so this must not be
		// confused with the "endpoint unavailable" signal a live instance can return.
		expect(archived).not.toBeNull();
		const ids = new Set(rows.map((row) => row.id));
		expect(ids.size).toBe(rows.length);
	});

	test("it announces its provenance, including the snapshot's age", () => {
		expect(source.provenance()).toContain(snapshot.takenAt);
		expect(source.provenance()).toMatch(/NOT live/i);
	});

	test("it advertises no pacing, because it makes no requests", () => {
		expect(source.concurrency()).toBeUndefined();
		expect(source.pacingSummary()).toBeUndefined();
	});
});
