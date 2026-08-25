import { describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import {
	createWorkItem,
	fetchWorkItems,
	findWorkItemByExternalId,
	updateWorkItem,
} from "../../../src/plane/issues.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("createWorkItem", () => {
	test("maps all fields into the request body", async () => {
		const { client, createdItems } = makeFakeClient();

		const ref = await createWorkItem(client, PROJECT_ID, {
			name: "Log in",
			body: "User can log in.\n\n- [ ] enters email",
			labelIds: ["lbl-1"],
			assigneeId: "user-1",
			priority: "high",
			estimate: 3,
			stateId: "state-1",
			externalId: "log-in",
			externalSource: "planestories",
		});

		expect(ref).toEqual({ id: "wi-101", sequenceId: 101 });

		const body = createdItems[0]!.body;
		expect(body.name).toBe("Log in");
		expect(body.labels).toEqual(["lbl-1"]);
		expect(body.assignees).toEqual(["user-1"]);
		expect(body.priority).toBe("high");
		expect(body.point).toBe(3);
		expect(body.state).toBe("state-1");
		expect(body.external_id).toBe("log-in");
		expect(body.external_source).toBe("planestories");
		// Body is converted from markdown to HTML.
		expect(String(body.description_html)).toContain("<p>User can log in.</p>");
	});

	test("omits description_html for an empty body", async () => {
		const { client, createdItems } = makeFakeClient();
		await createWorkItem(client, PROJECT_ID, { name: "No body" });
		expect(createdItems[0]!.body.description_html).toBeUndefined();
	});
});

describe("updateWorkItem", () => {
	test("updates by work item id and does not set external fields", async () => {
		const { client, updatedItems } = makeFakeClient();

		await updateWorkItem(client, PROJECT_ID, "wi-7", { name: "Renamed", priority: "low" });

		expect(updatedItems[0]!.workItemId).toBe("wi-7");
		expect(updatedItems[0]!.body.name).toBe("Renamed");
		expect(updatedItems[0]!.body.priority).toBe("low");
		expect(updatedItems[0]!.body.external_id).toBeUndefined();
	});
});

describe("findWorkItemByExternalId", () => {
	test("returns a ref when a work item matches the external id", async () => {
		const { client } = makeFakeClient({
			workItems: {
				[PROJECT_ID]: [{ id: "wi-9", sequence_id: 9, external_id: "log-in" }],
			},
		});

		const ref = await findWorkItemByExternalId(client, PROJECT_ID, "log-in", "planestories");
		expect(ref).toEqual({ id: "wi-9", sequenceId: 9 });
	});

	test("returns null when nothing matches", async () => {
		const { client } = makeFakeClient({
			workItems: { [PROJECT_ID]: [{ id: "wi-9", sequence_id: 9, external_id: "other" }] },
		});

		const ref = await findWorkItemByExternalId(client, PROJECT_ID, "log-in", "planestories");
		expect(ref).toBeNull();
	});
});

describe("fetchWorkItems", () => {
	test("normalizes expanded work items", async () => {
		const { client } = makeFakeClient({
			workItems: {
				[PROJECT_ID]: [
					{
						id: "wi-1",
						sequence_id: 8,
						name: "Log in",
						description_html: "<p>User can log in.</p>",
						priority: "high",
						point: 3,
						state: { id: "s1", name: "Backlog" },
						assignees: [{ id: "u1", email: "jane@co.com", display_name: "jane" }],
						labels: [{ id: "l1", name: "Feature" }],
					},
				],
			},
		});

		const items = await fetchWorkItems(client, PROJECT_ID);
		expect(items).toHaveLength(1);
		const item = items[0]!;
		expect(item.id).toBe("wi-1");
		expect(item.sequenceId).toBe(8);
		expect(item.name).toBe("Log in");
		expect(item.description).toBe("User can log in.");
		expect(item.priority).toBe("high");
		expect(item.estimate).toBe(3);
		expect(item.stateName).toBe("Backlog");
		expect(item.assigneeEmail).toBe("jane@co.com");
		expect(item.labels).toEqual(["Feature"]);
	});

	test("treats priority 'none' as undefined", async () => {
		const { client } = makeFakeClient({
			workItems: {
				[PROJECT_ID]: [{ id: "wi-2", sequence_id: 9, name: "Thing", priority: "none" }],
			},
		});

		const items = await fetchWorkItems(client, PROJECT_ID);
		expect(items[0]!.priority).toBeUndefined();
	});

	test("rejects a null name at the API boundary and names the work item", async () => {
		const { client } = makeFakeClient({
			workItems: {
				[PROJECT_ID]: [{ id: "wi-null-name", sequence_id: 10, name: null }],
			},
		});

		try {
			await fetchWorkItems(client, PROJECT_ID);
			throw new Error("expected fetchWorkItems to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(PlaneApiError);
			expect((error as Error).message).toContain("wi-null-name");
			expect((error as Error).message).toContain("name");
		}
	});
});

/**
 * Identity is validated at the API boundary, BEFORE anything builds an
 * identifier or a URL from it.
 *
 * Measured before the fix: a malformed response produced
 * `identifier: DATA-undefined` and `url: .../issues/undefined`. That is the
 * lucky case, because it is visibly broken. The unlucky one is a STRING
 * sequence: `"42"` coerced to the entirely plausible `DATA-42`, pointing at
 * whatever really is item 42. A wrong identifier that looks right is worse than
 * one that looks wrong, and both are worse than a refusal.
 */
describe("work-item identity is validated, not cast", () => {
	// Driven through `fetchWorkItems` rather than the private normaliser: the
	// guard has to fire on the path that BUILDS an identifier and a URL, which is
	// where the wrong value would have surfaced.
	const good = { id: "wi-1", sequence_id: 7, name: "A story" };
	const fetchWith = (item: Record<string, unknown>) =>
		fetchWorkItems(makeFakeClient({ workItems: { [PROJECT_ID]: [item] } }).client, PROJECT_ID);

	test.each([
		["absent", undefined],
		["empty", ""],
		["the literal string undefined", "undefined"],
		["an object cast to a string", "[object Object]"],
	])("an id that is %s is refused", async (_label, id) => {
		await expect(fetchWith({ ...good, id })).rejects.toThrow(/invalid id/i);
	});

	test.each([
		["a numeric string", "42"],
		["absent", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
	])("a sequence_id that is %s is refused", async (_label, sequence_id) => {
		await expect(fetchWith({ ...good, sequence_id })).rejects.toThrow(/invalid sequence_id/i);
	});

	test('the "42" refusal explains WHY a plausible value is rejected', async () => {
		// Without the reason, the obvious "fix" is to coerce it — which IS the
		// defect: "42" becomes DATA-42, pointing at whatever really is item 42.
		await expect(fetchWith({ ...good, sequence_id: "42" })).rejects.toThrow(/plausible/i);
	});

	test("a well-formed item still fetches", async () => {
		const items = await fetchWith(good);
		expect(items[0]?.sequenceId).toBe(7);
		expect(items[0]?.name).toBe("A story");
	});
});

/**
 * Identity validation on the WRITE path, not just on reads.
 *
 * The first version covered list responses only — so an import, which is the
 * ordinary write path and the busier one, still trusted the POST/PATCH echo. A
 * string sequence in a create response would have been written back into the
 * story file as a plausible `DATA-42` pointing at a different item.
 */
describe("create/update/lookup validate identity too", () => {
	test("a create response with a string sequence_id is refused", async () => {
		const { client } = makeFakeClient({});
		const original = client.createWorkItem.bind(client);
		void original;
		(client as unknown as Record<string, unknown>).createWorkItem = async () => ({
			id: "wi-1",
			sequence_id: "42",
			name: "x",
		});
		await expect(createWorkItem(client, PROJECT_ID, { name: "x" } as never)).rejects.toThrow(
			/invalid sequence_id/i,
		);
	});

	test("an update response with a missing id is refused", async () => {
		const { client } = makeFakeClient({});
		(client as unknown as Record<string, unknown>).updateWorkItem = async () => ({
			sequence_id: 7,
			name: "x",
		});
		await expect(
			updateWorkItem(client, PROJECT_ID, "wi-1", { name: "x" } as never),
		).rejects.toThrow(/invalid id/i);
	});

	test("a well-formed create response still returns its ref", async () => {
		const { client } = makeFakeClient({});
		(client as unknown as Record<string, unknown>).createWorkItem = async () => ({
			id: "wi-1",
			sequence_id: 7,
			name: "x",
		});
		const ref = await createWorkItem(client, PROJECT_ID, { name: "x" } as never);
		expect(ref).toEqual({ id: "wi-1", sequenceId: 7 });
	});
});
