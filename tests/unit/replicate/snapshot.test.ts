import { describe, expect, test } from "bun:test";
import type { PlaneIssueRelations } from "../../../src/plane/client.ts";
import {
	canonicalJson,
	computeSnapshotDigest,
	parseSnapshot,
	type SnapshotClient,
	serializeSnapshot,
	takeSnapshot,
} from "../../../src/replicate/snapshot.ts";
import { sampleSnapshot } from "./fixtures.ts";

const EMPTY_RELATIONS: PlaneIssueRelations = {
	blocking: [],
	blocked_by: [],
	relates_to: [],
	duplicate: [],
	start_before: [],
	start_after: [],
	finish_before: [],
	finish_after: [],
};

/** Minimal snapshot-read fake; overrides let each test break one surface. */
function snapshotClient(overrides: Partial<SnapshotClient> = {}): SnapshotClient {
	return {
		baseUrl: "https://src",
		workspaceSlug: "src",
		dialect: "issues",
		async getProject<T>(): Promise<T> {
			return { id: "p", name: "P", identifier: "P", description: "" } as T;
		},
		async listProjects<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listStates<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listLabels<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listProjectMembers<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listWorkspaceMembers<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listWorkItems<T>(): Promise<T[]> {
			return [
				{ id: "item-a", sequence_id: 1, name: "A" },
				{ id: "item-b", sequence_id: 3, name: "B" },
			] as T[];
		},
		async listArchivedWorkItems<T>(): Promise<T[] | null> {
			return [] as T[];
		},
		async getRelations(): Promise<PlaneIssueRelations> {
			return EMPTY_RELATIONS;
		},
		async listWorkItemComments<T>(): Promise<T[]> {
			return [] as T[];
		},
		async listWorkItemActivities<T>(): Promise<T[]> {
			return [] as T[];
		},
		...overrides,
	};
}

describe("activity capture (--with-activity)", () => {
	const ACTIVITY_CLIENT: Partial<SnapshotClient> = {
		async listWorkItemActivities<T>(_p: string, itemId: string): Promise<T[]> {
			if (itemId !== "item-a") return [] as T[];
			// Deliberately out of order, so the assertion below tests SORTING and
			// not merely that the fetch happened.
			return [
				{ id: "act-2", verb: "updated", field: "state", created_at: "2025-03-02T00:00:00Z" },
				{ id: "act-1", verb: "created", field: null, created_at: "2025-03-01T00:00:00Z" },
			] as T[];
		},
	};

	test("without the flag, absence is EXPLICIT — no section, and the source says not-requested", async () => {
		const snapshot = await takeSnapshot(
			snapshotClient(ACTIVITY_CLIENT),
			{ projectId: "p" },
			{ toolVersion: "t", now: () => "2025-01-01T00:00:00Z" },
		);
		// The whole point of the discriminator: a reader must never have to guess
		// whether an empty result means "no history" or "nobody looked".
		expect(snapshot.activities).toBeUndefined();
		expect(snapshot.source.activityInventory).toBe("not-requested");
	});

	test("with the flag, entries are captured, normalized and deterministically ordered", async () => {
		const snapshot = await takeSnapshot(
			snapshotClient(ACTIVITY_CLIENT),
			{ projectId: "p" },
			{ toolVersion: "t", now: () => "2025-01-01T00:00:00Z", withActivity: true },
		);
		expect(snapshot.source.activityInventory).toBe("captured");
		expect(snapshot.activities?.["item-a"]).toEqual([
			{
				id: "act-1",
				verb: "created",
				field: null,
				oldValue: null,
				newValue: null,
				actor: null,
				createdAt: "2025-03-01T00:00:00Z",
				comment: null,
			},
			{
				id: "act-2",
				verb: "updated",
				field: "state",
				oldValue: null,
				newValue: null,
				actor: null,
				createdAt: "2025-03-02T00:00:00Z",
				comment: null,
			},
		]);
		// item-b returned []; an item with no history is OMITTED, and that reads
		// as "none" only because the sweep is fail-hard (see the next test).
		expect(snapshot.activities && "item-b" in snapshot.activities).toBe(false);
	});

	test("a single failed activity read aborts the whole snapshot", async () => {
		// The load-bearing behaviour: if a partial activity sweep could reach disk,
		// the omission that means "no history" would also mean "unreadable", and
		// the archive would stop being evidence of anything.
		await expect(
			takeSnapshot(
				snapshotClient({
					async listWorkItemActivities<T>(_p: string, itemId: string): Promise<T[]> {
						if (itemId === "item-b") throw new Error("429 slow down");
						return [] as T[];
					},
				}),
				{ projectId: "p" },
				{ toolVersion: "t", now: () => "2025-01-01T00:00:00Z", withActivity: true },
			),
		).rejects.toThrow(/activity fetch failed for 1 item/);
	});

	test("a captured snapshot round-trips through parse", async () => {
		const snapshot = await takeSnapshot(
			snapshotClient(ACTIVITY_CLIENT),
			{ projectId: "p" },
			{ toolVersion: "t", now: () => "2025-01-01T00:00:00Z", withActivity: true },
		);
		const parsed = parseSnapshot(serializeSnapshot(snapshot));
		expect(parsed.activities?.["item-a"]?.length).toBe(2);
		expect(parsed.source.activityInventory).toBe("captured");
	});

	test('parse REJECTS "captured" with no activities section', () => {
		const snapshot = sampleSnapshot();
		snapshot.source.activityInventory = "captured";
		snapshot.digest = computeSnapshotDigest(snapshot);
		expect(() => parseSnapshot(serializeSnapshot(snapshot))).toThrow(/carries no "activities"/);
	});

	test("parse REJECTS an activities section that was never declared captured", () => {
		const snapshot = sampleSnapshot();
		snapshot.activities = { "source-1": [] };
		snapshot.digest = computeSnapshotDigest(snapshot);
		expect(() => parseSnapshot(serializeSnapshot(snapshot))).toThrow(/refusing to guess/);
	});

	test("activities are digest-bound: editing one invalidates the file", async () => {
		const snapshot = await takeSnapshot(
			snapshotClient(ACTIVITY_CLIENT),
			{ projectId: "p" },
			{ toolVersion: "t", now: () => "2025-01-01T00:00:00Z", withActivity: true },
		);
		const tampered = serializeSnapshot(snapshot).replace('"verb": "created"', '"verb": "deleted"');
		expect(() => parseSnapshot(tampered)).toThrow(/digest mismatch/);
	});
});

describe("snapshot backward compatibility", () => {
	test("an activity-less snapshot keeps its EXACT pre-activity digest", () => {
		// Pinned from the implementation before activity capture existed. Every
		// nightly backup on disk is an activity-less snapshot, so a change to the
		// digest formula that touches them would silently invalidate the operator's
		// entire backup history — this test is the tripwire for that, and it is
		// SUPPOSED to fail if anyone adds a section that alters absent-key handling.
		expect(sampleSnapshot().digest).toBe(
			"8896e27ba421e04b71e5f27447e9e17df102d9eba42f76b16e1dd72d85dc8812",
		);
	});

	test("a snapshot written before the field existed still parses", () => {
		const legacy = sampleSnapshot();
		expect("activityInventory" in legacy.source).toBe(false);
		expect(parseSnapshot(serializeSnapshot(legacy)).items.length).toBe(legacy.items.length);
	});
});

describe("snapshot digest", () => {
	test("is content-based: identical content yields identical digests across snapshots", async () => {
		const a = await takeSnapshot(
			snapshotClient(),
			{ projectId: "p" },
			{
				toolVersion: "1",
				now: () => "2025-01-01T00:00:00Z",
			},
		);
		const b = await takeSnapshot(
			snapshotClient(),
			{ projectId: "p" },
			{
				toolVersion: "2",
				now: () => "2026-06-06T06:06:06Z",
			},
		);
		// takenAt and toolVersion differ; the content digest must not.
		expect(a.digest).toBe(b.digest);
	});

	test("canonicalJson is key-order independent (a reordered file still verifies)", () => {
		expect(canonicalJson({ b: 1, a: [{ y: 2, x: 3 }] })).toBe(
			canonicalJson({ a: [{ x: 3, y: 2 }], b: 1 }),
		);
		const snapshot = sampleSnapshot();
		const reordered = JSON.parse(serializeSnapshot(snapshot));
		// Simulate a tool rewriting the file with different key order.
		const shuffled = { digest: reordered.digest, items: reordered.items, ...reordered };
		expect(() => parseSnapshot(`${JSON.stringify(shuffled)}\n`)).not.toThrow();
	});

	test("parseSnapshot refuses an edited file (digest mismatch)", () => {
		const snapshot = sampleSnapshot();
		const edited = JSON.parse(serializeSnapshot(snapshot));
		edited.items[0].name = "tampered";
		expect(() => parseSnapshot(JSON.stringify(edited))).toThrow(/digest mismatch/);
	});

	test("parseSnapshot refuses missing sections, bad JSON, and unsupported versions", () => {
		expect(() => parseSnapshot("not json")).toThrow(/not valid JSON/);
		const snapshot = JSON.parse(serializeSnapshot(sampleSnapshot()));
		snapshot.schemaVersion = 99;
		expect(() => parseSnapshot(JSON.stringify(snapshot))).toThrow(/version 99/);
		const missing = JSON.parse(serializeSnapshot(sampleSnapshot()));
		missing.states = undefined;
		expect(() => parseSnapshot(JSON.stringify(missing))).toThrow(/"states" section/);
	});

	test("parseSnapshot enforces strictly ascending sequence order", () => {
		const snapshot = sampleSnapshot();
		const swapped = {
			...snapshot,
			items: [...snapshot.items].reverse(),
		};
		swapped.digest = computeSnapshotDigest(swapped);
		expect(() => parseSnapshot(`${JSON.stringify(swapped)}\n`)).toThrow(/ascending/);
	});
});

describe("takeSnapshot fail-hard", () => {
	test("aborts when any relation fetch still fails after the sweep", async () => {
		const client = snapshotClient({
			async getRelations(_p: string, itemId: string): Promise<PlaneIssueRelations> {
				if (itemId === "item-b") throw new Error("persistent 429");
				return EMPTY_RELATIONS;
			},
		});
		await expect(takeSnapshot(client, { projectId: "p" }, { toolVersion: "t" })).rejects.toThrow(
			/Snapshot incomplete: relation fetch failed/,
		);
	});

	test("aborts when any comment fetch still fails after the sweep", async () => {
		const client = snapshotClient({
			async listWorkItemComments<T>(): Promise<T[]> {
				throw new Error("persistent 429");
			},
		});
		await expect(takeSnapshot(client, { projectId: "p" }, { toolVersion: "t" })).rejects.toThrow(
			/Snapshot incomplete: comment fetch failed/,
		);
	});

	test("aborts on an unrecognizable relation reference instead of dropping it", async () => {
		// Silently filtering a weird ref would yield a digest-valid snapshot
		// that is quietly missing edges — the exact "mostly complete" failure
		// the fail-hard contract forbids.
		const client = snapshotClient({
			async getRelations(_p: string, itemId: string): Promise<PlaneIssueRelations> {
				if (itemId === "item-a") {
					return {
						...EMPTY_RELATIONS,
						blocked_by: [{ some_new_shape: true }] as unknown as string[],
					};
				}
				return EMPTY_RELATIONS;
			},
		});
		await expect(takeSnapshot(client, { projectId: "p" }, { toolVersion: "t" })).rejects.toThrow(
			/Unrecognizable blocked_by relation reference/,
		);
	});

	test("records an unavailable archived inventory and duplicate sequences fail loudly", async () => {
		const unavailable = await takeSnapshot(
			snapshotClient({
				async listArchivedWorkItems<T>(): Promise<T[] | null> {
					return null;
				},
			}),
			{ projectId: "p" },
			{ toolVersion: "t" },
		);
		expect(unavailable.source.archivedInventory).toBe("unavailable");
		expect(unavailable.sequence.gaps).toEqual([2]);

		const duplicated = snapshotClient({
			async listWorkItems<T>(): Promise<T[]> {
				return [
					{ id: "item-a", sequence_id: 1, name: "A" },
					{ id: "item-b", sequence_id: 1, name: "B" },
				] as T[];
			},
		});
		await expect(
			takeSnapshot(duplicated, { projectId: "p" }, { toolVersion: "t" }),
		).rejects.toThrow(/two items with sequence number 1/);
	});
});
