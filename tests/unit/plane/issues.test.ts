import { describe, expect, test } from "bun:test";
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
});
