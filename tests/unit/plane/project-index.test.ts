import { describe, expect, test } from "bun:test";
import { fetchProjectIndex, normalizeTitle } from "../../../src/plane/issues.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT = "p-1";

describe("normalizeTitle", () => {
	test("trims, lowercases, and collapses whitespace", () => {
		expect(normalizeTitle("  Hello   World  ")).toBe("hello world");
		expect(normalizeTitle("ALL\tCAPS")).toBe("all caps");
	});
});

describe("fetchProjectIndex", () => {
	test("builds byId / byIdentifier / byNormalizedTitle / childrenByParent from one list", async () => {
		const { client, calls } = makeFakeClient({
			projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
			workItems: {
				[PROJECT]: [
					{ id: "a", sequence_id: 1, name: "Login" },
					{ id: "b", sequence_id: 2, name: "login" }, // same normalized title as "a"
					{ id: "c", sequence_id: 3, name: "enters email", parent: "a", external_id: "login::ac0" },
				],
			},
		});

		const index = await fetchProjectIndex(client, PROJECT, "ENG");

		expect(index.items).toHaveLength(3);
		expect(index.byId.get("a")?.sequenceId).toBe(1);
		expect(index.byIdentifier.get("ENG-2")?.id).toBe("b");
		// Duplicate titles collapse to one normalized key with both items.
		expect(
			index.byNormalizedTitle
				.get("login")
				?.map((i) => i.id)
				.sort(),
		).toEqual(["a", "b"]);
		// Criterion child grouped under its parent.
		expect(index.childrenByParent.get("a")?.map((i) => i.id)).toEqual(["c"]);
		// Exactly one list call — no per-item GETs.
		expect(calls.filter((c) => c.method === "listWorkItems")).toHaveLength(1);
		expect(calls.filter((c) => c.method === "getWorkItem")).toHaveLength(0);
	});
});
