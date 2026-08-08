import { describe, expect, test } from "bun:test";
import { fetchRelationsWithSweep } from "../../../src/atlas/relations.ts";

interface Item {
	id: string;
}

/** A stub client whose getRelations fails the first `failuresPerItem[id]` calls. */
function stubClient(failuresPerItem: Record<string, number>) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			getRelations: async (_projectId: string, itemId: string) => {
				calls.push(itemId);
				const remaining = failuresPerItem[itemId] ?? 0;
				if (remaining > 0) {
					failuresPerItem[itemId] = remaining - 1;
					throw new Error("429 simulated");
				}
				return {
					blocking: [itemId === "a" ? "b" : ""],
					blocked_by: [],
					relates_to: [],
					duplicate: [],
					start_before: [],
					start_after: [],
					finish_before: [],
					finish_after: [],
				};
			},
		},
	};
}

describe("fetchRelationsWithSweep", () => {
	const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

	test("clean run: one call per item, zero failures", async () => {
		const { client, calls } = stubClient({});
		const { relationsById, failed } = await fetchRelationsWithSweep(client, "p1", items);
		expect(failed).toBe(0);
		expect(relationsById.size).toBe(3);
		expect(calls.length).toBe(3);
	});

	test("rate-limited items are recovered by the paced second pass", async () => {
		// "b" fails once (first pass), succeeds on the sweep; others clean.
		const { client, calls } = stubClient({ b: 1 });
		const { relationsById, failed } = await fetchRelationsWithSweep(client, "p1", items);
		expect(failed).toBe(0);
		expect(relationsById.size).toBe(3);
		expect(relationsById.has("b")).toBe(true);
		expect(calls.filter((c) => c === "b").length).toBe(2);
	});

	test("recovered entries keep INPUT order (diff-stable output)", async () => {
		// "a" and "b" fail first pass and recover in the sweep; the map must still
		// iterate a, b, c — edge order (and the rendered HTML) must not depend on
		// request timing.
		const { client } = stubClient({ a: 1, b: 1 });
		const { relationsById } = await fetchRelationsWithSweep(client, "p1", items);
		expect([...relationsById.keys()]).toEqual(["a", "b", "c"]);
	});

	test("an item that keeps failing is reported, not fatal", async () => {
		const { client } = stubClient({ b: 99 });
		const { relationsById, failed } = await fetchRelationsWithSweep(client, "p1", items);
		expect(failed).toBe(1);
		expect(relationsById.size).toBe(2);
		expect(relationsById.has("b")).toBe(false);
	});
});
