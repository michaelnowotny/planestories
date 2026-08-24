import { describe, expect, test } from "bun:test";
import type { BoardCacheWorkItem } from "../../../src/cli/board_cache.ts";
import {
	AuditActorResolutionError,
	AuditBoundError,
	AuditReadError,
	auditWrites,
	parseAuditWindow,
} from "../../../src/sync/audit.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT = "project-1";
const NOW = new Date("2026-08-23T12:00:00.000Z");

function item(id: string, sequence: number, updatedAt: string | null): BoardCacheWorkItem {
	return {
		id,
		identifier: `DATA-${sequence}`,
		title: `Story ${sequence}`,
		updatedAt,
	};
}

describe("auditWrites", () => {
	test("walks only cached items inside the window, keeps only this actor, and sorts newest first", async () => {
		const fake = makeFakeClient({
			currentUser: {
				id: "actor-me",
				display_name: "Current Operator",
				email: "operator@example.test",
			},
			activities: {
				"inside-a": [
					{
						id: "mine-newer",
						actor: "actor-me",
						verb: "updated",
						field: "state",
						created_at: "2026-08-23T11:45:00Z",
					},
					{
						id: "someone-else",
						actor: "actor-other",
						verb: "updated",
						field: "priority",
						created_at: "2026-08-23T11:50:00Z",
					},
					{
						id: "mine-before-window",
						actor: "actor-me",
						verb: "updated",
						field: "name",
						created_at: "2026-08-23T09:59:59Z",
					},
				],
				"inside-b": [
					{
						id: "mine-older",
						actor: "actor-me",
						verb: "commented",
						field: null,
						created_at: "2026-08-23T11:15:00-00:00",
					},
				],
				outside: [
					{
						id: "must-not-be-read",
						actor: "actor-me",
						verb: "updated",
						field: "state",
						created_at: "2026-08-23T11:55:00Z",
					},
				],
			},
		});
		const window = parseAuditWindow("2h", NOW);
		const result = await auditWrites(
			fake.client,
			PROJECT,
			[
				item("inside-a", 1, "2026-08-23T11:30:00Z"),
				item("outside", 2, "2026-08-23T09:59:59Z"),
				item("inside-b", 3, "2026-08-23T10:00:00Z"),
			],
			window,
		);

		expect(result.actor).toEqual({
			id: "actor-me",
			displayName: "Current Operator",
			email: "operator@example.test",
		});
		expect(result.cachedItemCount).toBe(3);
		expect(result.walkedItemCount).toBe(2);
		expect(fake.calls.filter((call) => call.method === "listWorkItemActivities")).toEqual([
			{ method: "listWorkItemActivities", args: [PROJECT, "inside-a"] },
			{ method: "listWorkItemActivities", args: [PROJECT, "inside-b"] },
		]);
		expect(result.writes.map((write) => write.when)).toEqual([
			"2026-08-23T11:45:00.000Z",
			"2026-08-23T11:15:00.000Z",
		]);
		expect(result.writes.map((write) => write.identifier)).toEqual(["DATA-1", "DATA-3"]);
		expect(result.writes[0]).toMatchObject({
			title: "Story 1",
			verb: "updated",
			field: "state",
		});
		expect(result.writes[1]).toMatchObject({
			title: "Story 3",
			verb: "commented",
			field: null,
		});
		expect(result.writes.every((write) => write.instance === "https://api.plane.so")).toBe(true);
	});

	test("an unresolvable current actor refuses before any activity lookup", async () => {
		const fake = makeFakeClient({ currentUser: null });

		try {
			await auditWrites(
				fake.client,
				PROJECT,
				[item("inside", 1, "2026-08-23T11:00:00Z")],
				parseAuditWindow("2h", NOW),
			);
			throw new Error("expected actor-resolution refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(AuditActorResolutionError);
			expect((error as Error).message).toContain("will not widen to all activity");
			expect((error as Error).message).toContain("GET https://api.plane.so/api/v1/users/me/");
		}
		expect(fake.calls.map((call) => call.method)).toEqual(["getCurrentUser"]);
	});

	test("a missing cached updatedAt refuses instead of silently excluding an unknown item", async () => {
		const fake = makeFakeClient({ currentUser: { id: "actor-me" } });

		await expect(
			auditWrites(fake.client, PROJECT, [item("unknown", 1, null)], parseAuditWindow("2h", NOW)),
		).rejects.toBeInstanceOf(AuditBoundError);
		expect(fake.calls).toEqual([]);
	});

	test("a cached updatedAt after the audit clock refuses instead of being called inside the bound", async () => {
		const fake = makeFakeClient({ currentUser: { id: "actor-me" } });

		await expect(
			auditWrites(
				fake.client,
				PROJECT,
				[item("future", 1, "2026-08-23T12:00:01Z")],
				parseAuditWindow("2h", NOW),
			),
		).rejects.toBeInstanceOf(AuditBoundError);
		expect(fake.calls).toEqual([]);
	});

	test("a residual activity-read failure refuses instead of returning the successful subset", async () => {
		const fake = makeFakeClient({
			currentUser: { id: "actor-me" },
			activities: {
				readable: [
					{
						id: "would-be-partial",
						actor: "actor-me",
						verb: "updated",
						field: "state",
						created_at: "2026-08-23T11:00:00Z",
					},
				],
			},
		});
		const original = fake.client.listWorkItemActivities.bind(fake.client);
		fake.client.listWorkItemActivities = async <T>(
			projectId: string,
			workItemId: string,
		): Promise<T[]> => {
			if (workItemId === "failing") throw new Error("simulated activity failure");
			return original<T>(projectId, workItemId);
		};

		await expect(
			auditWrites(
				fake.client,
				PROJECT,
				[item("readable", 1, "2026-08-23T11:00:00Z"), item("failing", 2, "2026-08-23T11:00:00Z")],
				parseAuditWindow("2h", NOW),
			),
		).rejects.toBeInstanceOf(AuditReadError);
	});

	test("an activity whose actor is not a string refuses instead of reading as 'not me'", async () => {
		// The relation-dialect class of bug, relocated. Plane documents `actor` as a
		// UUID string and CE returns one — but were any deployment to nest it as an
		// object, `raw.actor !== actor.id` would hold for EVERY row, the
		// non-empty-trail guard would still pass, and audit would print a confident
		// "No matching writes..." for a session that wrote plenty. An unrecognised
		// shape is not evidence of absence.
		const fake = makeFakeClient({
			currentUser: { id: "actor-me" },
			activities: {
				inside: [
					{
						id: "mine",
						actor: { id: "actor-me", display_name: "Current Operator" },
						verb: "updated",
						field: "state",
						created_at: "2026-08-23T11:45:00Z",
					},
				],
			},
		});

		await expect(
			auditWrites(
				fake.client,
				PROJECT,
				[item("inside", 1, "2026-08-23T11:00:00Z")],
				parseAuditWindow("2h", NOW),
			),
		).rejects.toBeInstanceOf(AuditReadError);
	});

	test("a nonempty candidate set with zero activity refuses as a suspicious response", async () => {
		const fake = makeFakeClient({ currentUser: { id: "actor-me" } });

		await expect(
			auditWrites(
				fake.client,
				PROJECT,
				[item("inside", 1, "2026-08-23T11:00:00Z")],
				parseAuditWindow("2h", NOW),
			),
		).rejects.toBeInstanceOf(AuditReadError);
	});
});

describe("parseAuditWindow", () => {
	test("accepts bounded durations and ISO instants, and defaults to a bounded 24h", () => {
		expect(parseAuditWindow(undefined, NOW).since).toBe("2026-08-22T12:00:00.000Z");
		expect(parseAuditWindow("90m", NOW).since).toBe("2026-08-23T10:30:00.000Z");
		expect(parseAuditWindow("2026-08-23T08:00:00-04:00", NOW).since).toBe(
			"2026-08-23T12:00:00.000Z",
		);
	});

	test("rejects an unbounded or future value", () => {
		expect(() => parseAuditWindow("everything", NOW)).toThrow(/duration|ISO/i);
		expect(() => parseAuditWindow("2026-08-24T00:00:00Z", NOW)).toThrow(/future/i);
	});

	test("rejects a calendar-invalid ISO date instead of rolling it into March", () => {
		let error: unknown;
		try {
			parseAuditWindow("2026-02-30", NOW);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AuditBoundError);
		expect((error as Error).message).toContain("2026-02-30");
		expect((error as Error).message).toMatch(/calendar date/i);
	});

	test("rejects a finite duration outside Date's range as an AuditBoundError", () => {
		let error: unknown;
		try {
			parseAuditWindow("999999999999d", NOW);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AuditBoundError);
		expect((error as Error).message).toContain("999999999999d");
		expect((error as Error).message).toMatch(/supported date range/i);
	});
});
