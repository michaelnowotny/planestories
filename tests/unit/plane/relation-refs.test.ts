import { afterEach, describe, expect, test } from "bun:test";
import { ParseError } from "../../../src/errors.ts";
import { PlaneClient } from "../../../src/plane/client.ts";
import { normalizeRelations } from "../../../src/plane/relation_refs.ts";
import { collectDependencyEdges } from "../../../src/sync/relations.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** The two shapes Plane actually returns, measured live on 2026-08-17. */
const CLOUD_STYLE = { blocked_by: ["item-b"], blocking: [], relates_to: [] };
const CE_STYLE = {
	blocked_by: [{ project_id: "proj-1", issue_id: "item-b" }],
	blocking: [],
	relates_to: [],
};

function clientReturning(payload: unknown, dialect: "issues" | "work-items"): PlaneClient {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	return new PlaneClient({ apiKey: "k", workspaceSlug: "ws", dialect, maxRetries: 0 });
}

describe("relation reference normalization", () => {
	test("the /work-items/ object form becomes bare ids", () => {
		expect(normalizeRelations(CE_STYLE).blocked_by).toEqual(["item-b"]);
	});

	test("the /issues/ string form passes through unchanged", () => {
		expect(normalizeRelations(CLOUD_STYLE).blocked_by).toEqual(["item-b"]);
	});

	test("missing kinds become empty arrays, so callers can index freely", () => {
		const out = normalizeRelations({});
		expect(out.blocked_by).toEqual([]);
		expect(out.duplicate).toEqual([]);
		expect(out.finish_after).toEqual([]);
	});

	test("a malformed payload is a ParseError, so nothing can classify it as transient", () => {
		// It must NOT be a PlaneApiError with a 5xx status: isRetryableStatus() calls
		// 5xx transient, and a malformed payload is DETERMINISTIC — retrying it burns
		// the budget on a failure that cannot succeed, which is precisely what the
		// "retry only classified-transient failures" rule forbids. Found by review.
		let caught: unknown;
		try {
			normalizeRelations({ blocked_by: [{ nope: 1 }] });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ParseError);
		expect((caught as { status?: number }).status).toBeUndefined();
	});

	test("a NON-OBJECT payload throws — it is not an empty relation set", () => {
		// The regression this fix originally introduced, caught in review. `request()`
		// returns undefined for a 200 whose body is empty, truncated or HTML, so every
		// one of these is reachable. Turning them into eight empty arrays reports "no
		// dependencies" for an item whose edges we merely failed to read — the exact
		// defect this module exists to prevent, on a different input.
		for (const payload of [undefined, null, [], 42, "oops", true]) {
			expect(() => normalizeRelations(payload)).toThrow(/not an object/);
		}
	});

	test("an EMPTY-STRING ref is rejected, not passed through", () => {
		// "" would build a lookup key like "block:>item-a" that matches nothing —
		// the same silent miss as the object shape, with a different empty value.
		expect(() => normalizeRelations({ blocked_by: [""] })).toThrow(/Unrecognizable/);
		expect(() => normalizeRelations({ blocked_by: [{ issue_id: "  " }] })).toThrow(
			/Unrecognizable/,
		);
	});

	test("an UNRECOGNIZABLE ref throws instead of vanishing", () => {
		// Dropping it would hide an edge, and a caller that cannot see an edge
		// either deletes it from the board or re-creates it forever. Absence must
		// never be manufactured from confusion.
		expect(() => normalizeRelations({ blocked_by: [{ nope: 1 }] })).toThrow(/Unrecognizable/);
		expect(() => normalizeRelations({ blocked_by: [42] })).toThrow(/Unrecognizable/);
		expect(() => normalizeRelations({ blocked_by: "not-an-array" })).toThrow(/not an array/);
	});
});

describe("PlaneClient.getRelations normalizes at the boundary", () => {
	test("work-items dialect: callers receive bare ids, never objects", async () => {
		const relations = await clientReturning(CE_STYLE, "work-items").getRelations("p", "item-a");
		expect(relations.blocked_by).toEqual(["item-b"]);
		// The regression in one assertion: before the fix this was an object, and
		// every consumer used it directly as an id.
		expect(typeof relations.blocked_by[0]).toBe("string");
	});

	test("issues dialect: unchanged behaviour", async () => {
		const relations = await clientReturning(CLOUD_STYLE, "issues").getRelations("p", "item-a");
		expect(relations.blocked_by).toEqual(["item-b"]);
	});
});

describe("the shared fake honours the post-normalization contract", () => {
	test("a CE-shaped seed is returned to consumers as bare ids", async () => {
		// Review's suggestion, and the right granularity: the fake stands in for the
		// CLIENT, so it must expose what the client exposes. Seeding the wire shape
		// here proves the fake cannot drift from production's contract — while wire
		// variance itself stays tested at the HTTP boundary above, where it lives.
		const { makeFakeClient } = await import("../../helpers/fake-plane-client.ts");
		const { client } = makeFakeClient({
			projects: [{ id: "p", name: "P", identifier: "P" }],
			relations: {
				"item-a": {
					blocked_by: [{ project_id: "p", issue_id: "item-b" }] as unknown as string[],
				},
			},
		});
		const relations = await client.getRelations("p", "item-a");
		expect(relations.blocked_by).toEqual(["item-b"]);
	});
});

describe("the reported defect: existing relations must be SEEN, not re-created", () => {
	/**
	 * The finance session's symptom, reduced: on CE, `import` reported "would
	 * create 3" on every run against a board that already held those three
	 * relations, then re-POSTed them — accumulating a reversed edge until
	 * DATA-2569 and DATA-2570 blocked each other.
	 *
	 * The cause was never the write path. It was that an object-shaped reference
	 * used as an id produced the key "[object Object]", so no existing edge ever
	 * matched a desired one.
	 */
	test("an existing CE-shaped edge is recognized as already present", async () => {
		const client = clientReturning(CE_STYLE, "work-items");
		const relations = await client.getRelations("p", "item-a");
		const edges = collectDependencyEdges(new Map([["item-a", relations]]));

		// One edge, keyed by real ids on both ends — so a desired edge built from
		// the same ids matches it and reconciliation creates nothing.
		expect(edges.size).toBe(1);
		const [edge] = [...edges.values()];
		expect(edge).toMatchObject({ kind: "block", blocker: "item-b", blocked: "item-a" });
		expect([...edges.keys()][0]).not.toContain("object Object");
	});
});
