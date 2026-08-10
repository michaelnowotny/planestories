import { describe, expect, test } from "bun:test";
import { PlaneApiError, ReplicateError } from "../../../src/errors.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "../../../src/plane/client.ts";
import { detectDialect, detectSourceDialect } from "../../../src/replicate/probe.ts";
import { takeSnapshot } from "../../../src/replicate/snapshot.ts";

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

/**
 * A dialect-split fake: mirrors the live finding on the operator's CE, where
 * /issues/ lists items and creates them fine but 404s the RELATIONS endpoints,
 * which exist only under /work-items/.
 */
function splitInstance(servesRelationsOn: PlaneEndpointDialect | "both") {
	let seq = 0;
	const writes: string[] = [];
	const factory = (dialect: PlaneEndpointDialect) => ({
		dialect,
		writes,
		async createProject<T>(body: Record<string, unknown>): Promise<T> {
			writes.push(`createProject:${String(body.identifier)}`);
			return { id: "temp-project", identifier: body.identifier } as T;
		},
		async deleteProject(projectId: string): Promise<void> {
			writes.push(`deleteProject:${projectId}`);
		},
		async createWorkItem<T>(): Promise<T> {
			seq++;
			writes.push(`createWorkItem:${dialect}`);
			return { id: `item-${seq}`, sequence_id: seq } as T;
		},
		async listWorkItems<T>(): Promise<T[]> {
			return [{ id: "item-existing", sequence_id: 1 }] as T[];
		},
		async listArchivedWorkItems<T>(): Promise<T[] | null> {
			return [] as T[];
		},
		async getRelations(): Promise<PlaneIssueRelations> {
			if (servesRelationsOn !== "both" && servesRelationsOn !== dialect) {
				throw new PlaneApiError("Page not found.", 404);
			}
			return EMPTY_RELATIONS;
		},
	});
	return { factory, writes };
}

describe("dialect detection", () => {
	test("prefers /issues/ when it serves the full surface (the proven family)", async () => {
		const split = splitInstance("both");
		expect(await detectDialect((d) => split.factory(d) as never)).toBe("issues");
	});

	test("falls back to /work-items/ when /issues/ 404s the relations endpoints", async () => {
		// The live CE finding: item creates succeed under /issues/ but the
		// relations surface exists only under /work-items/.
		const split = splitInstance("work-items");
		expect(await detectDialect((d) => split.factory(d) as never)).toBe("work-items");
		// The throwaway project is always deleted.
		expect(split.writes.filter((w) => w.startsWith("deleteProject"))).toHaveLength(1);
	});

	test("fails closed when neither family serves relations", async () => {
		const none = {
			factory: (dialect: PlaneEndpointDialect) => ({
				...splitInstance("both").factory(dialect),
				async getRelations(): Promise<PlaneIssueRelations> {
					throw new PlaneApiError("Page not found.", 404);
				},
			}),
		};
		await expect(detectDialect((d) => none.factory(d) as never)).rejects.toThrow(ReplicateError);
	});

	test("source-side detection is read-only and uses the project's own items", async () => {
		const split = splitInstance("work-items");
		const dialect = await detectSourceDialect((d) => split.factory(d), "src-project");
		expect(dialect).toBe("work-items");
		expect(split.writes).toHaveLength(0);
	});

	test("an archived-only project is not misread as empty (archived items discriminate)", async () => {
		// Codex review scenario: live inventory is empty under BOTH dialects but
		// archived items exist. Choosing /issues/ on its empty live list would
		// send every later relation read to the known-broken family.
		const dialect = await detectSourceDialect(
			(d) => ({
				dialect: d,
				async listWorkItems<T>(): Promise<T[]> {
					return [];
				},
				async listArchivedWorkItems<T>(): Promise<T[] | null> {
					// /issues/ archived endpoint absent; /work-items/ serves it.
					return d === "work-items" ? ([{ id: "arch-1" }] as T[]) : null;
				},
				async getRelations(): Promise<PlaneIssueRelations> {
					if (d !== "work-items") throw new PlaneApiError("Page not found.", 404);
					return EMPTY_RELATIONS;
				},
			}),
			"src-project",
		);
		expect(dialect).toBe("work-items");
	});

	test("source-side detection returns the first listing dialect for an empty project", async () => {
		const dialect = await detectSourceDialect(
			(d) => ({
				dialect: d,
				async listWorkItems<T>(): Promise<T[]> {
					return [];
				},
				async listArchivedWorkItems<T>(): Promise<T[] | null> {
					return null;
				},
				async getRelations(): Promise<PlaneIssueRelations> {
					throw new Error("must not be called for an empty project");
				},
			}),
			"src-project",
		);
		expect(dialect).toBe("issues");
	});
});

describe("relation reference normalization", () => {
	test("object-shaped relation refs ({project_id, issue_id}) normalize to item UUIDs", async () => {
		// The /work-items/ dialect returns objects where /issues/ returns bare
		// UUID strings (observed live on CE). The snapshot must store UUIDs.
		const items = [
			{ id: "item-a", sequence_id: 1, name: "A" },
			{ id: "item-b", sequence_id: 2, name: "B" },
		];
		const client = {
			baseUrl: "https://src",
			workspaceSlug: "src",
			dialect: "work-items" as const,
			async getProject<T>(): Promise<T> {
				return { id: "p", name: "P", identifier: "P" } as T;
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
				return items as T[];
			},
			async listArchivedWorkItems<T>(): Promise<T[] | null> {
				return [] as T[];
			},
			async getRelations(_p: string, itemId: string): Promise<PlaneIssueRelations> {
				if (itemId === "item-a") {
					return {
						...EMPTY_RELATIONS,
						blocked_by: [{ project_id: "p", issue_id: "item-b" }] as unknown as string[],
					};
				}
				return EMPTY_RELATIONS;
			},
			async listWorkItemComments<T>(): Promise<T[]> {
				return [] as T[];
			},
		};
		const snapshot = await takeSnapshot(
			client,
			{ projectId: "p" },
			{ toolVersion: "test", now: () => "2025-01-01T00:00:00Z" },
		);
		expect(snapshot.relations["item-a"]?.blocked_by).toEqual(["item-b"]);
	});
});

describe("codex P3 round fixes", () => {
	test("duplicate attribute names disable sort-normalization (order stays semantic)", async () => {
		const { normalizeHtmlForCompare } = await import("../../../src/replicate/verify.ts");
		// <a href=safe href=evil> vs reversed: browsers honor the FIRST href, so
		// sorting would erase a real semantic difference.
		const a = '<a href="safe" href="evil">x</a>';
		const b = '<a href="evil" href="safe">x</a>';
		expect(normalizeHtmlForCompare(a)).not.toBe(normalizeHtmlForCompare(b));
		// Duplicate-free tags still normalize order-insensitively.
		expect(normalizeHtmlForCompare('<a b="1" a="2">x</a>')).toBe(
			normalizeHtmlForCompare('<a a="2" b="1">x</a>'),
		);
	});

	test("maxInstant ordering is total down to sub-millisecond digits (X1)", async () => {
		const { compareInstants } = await import("../../../src/replicate/instants.ts");
		// Same millisecond, different microseconds: ordering must not depend on
		// input order (a reversed API page produced a false-stale).
		expect(compareInstants("2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.123999Z")).toBe(-1);
		expect(compareInstants("2026-01-01T00:00:00.123999Z", "2026-01-01T00:00:00.123456Z")).toBe(1);
		expect(compareInstants("2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123000Z")).toBe(0);
	});

	test("microsecond-precision instants are not conflated by millisecond parsing", async () => {
		const { sameNullableInstant } = await import("../../../src/replicate/instants.ts");
		expect(sameNullableInstant("2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.123999Z")).toBe(
			false,
		);
		expect(sameNullableInstant("2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123000Z")).toBe(
			true,
		);
		expect(sameNullableInstant("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z")).toBe(true);
		expect(sameNullableInstant(null, null)).toBe(true);
		expect(sameNullableInstant("2026-01-01T00:00:00Z", null)).toBe(false);
	});
});
