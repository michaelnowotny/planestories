import { describe, expect, test } from "bun:test";
import { ResolverError } from "../../../src/errors.ts";
import { Resolver } from "../../../src/plane/resolvers.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT = { id: "11111111-1111-4111-8111-111111111111", name: "Web App", identifier: "WEB" };

describe("Resolver.resolveProject", () => {
	test("resolves a project name to id + identifier", async () => {
		const { client } = makeFakeClient({ projects: [PROJECT] });
		const resolver = new Resolver(client);

		const resolved = await resolver.resolveProject("Web App");
		expect(resolved).toEqual({ id: PROJECT.id, identifier: "WEB" });
	});

	test("passes through a UUID by matching on id", async () => {
		const { client } = makeFakeClient({ projects: [PROJECT] });
		const resolver = new Resolver(client);

		const resolved = await resolver.resolveProject(PROJECT.id);
		expect(resolved.identifier).toBe("WEB");
	});

	test("throws ResolverError when not found", async () => {
		const { client } = makeFakeClient({ projects: [PROJECT] });
		const resolver = new Resolver(client);

		expect(resolver.resolveProject("Nonexistent")).rejects.toThrow(ResolverError);
	});

	test("caches lookups (lists projects once)", async () => {
		const { client, calls } = makeFakeClient({ projects: [PROJECT] });
		const resolver = new Resolver(client);

		await resolver.resolveProject("Web App");
		await resolver.resolveProject("Web App");
		expect(calls.filter((c) => c.method === "listProjects")).toHaveLength(1);
	});
});

describe("Resolver.resolveLabelIds", () => {
	const labels = { [PROJECT.id]: [{ id: "lbl-feature", name: "Feature" }] };

	test("maps existing label names to ids (case-insensitive)", async () => {
		const { client } = makeFakeClient({ labels });
		const resolver = new Resolver(client);

		const ids = await resolver.resolveLabelIds(PROJECT.id, ["feature"]);
		expect(ids).toEqual(["lbl-feature"]);
	});

	test("skips missing labels by default", async () => {
		const { client, createdLabels } = makeFakeClient({ labels });
		const resolver = new Resolver(client);

		const ids = await resolver.resolveLabelIds(PROJECT.id, ["Feature", "Ghost"]);
		expect(ids).toEqual(["lbl-feature"]);
		expect(createdLabels).toHaveLength(0);
	});

	test("creates missing labels when createMissing is true", async () => {
		const { client, createdLabels } = makeFakeClient({ labels });
		const resolver = new Resolver(client);

		const ids = await resolver.resolveLabelIds(PROJECT.id, ["Feature", "Ghost"], true);
		expect(ids).toEqual(["lbl-feature", "label-ghost"]);
		expect(createdLabels).toEqual([{ projectId: PROJECT.id, name: "Ghost" }]);
	});

	test("returns empty array for empty input", async () => {
		const { client } = makeFakeClient({ labels });
		const resolver = new Resolver(client);
		expect(await resolver.resolveLabelIds(PROJECT.id, [])).toEqual([]);
	});
});

describe("Resolver.resolveStateId", () => {
	const states = {
		[PROJECT.id]: [
			{ id: "state-backlog", name: "Backlog" },
			{ id: "state-done", name: "Done" },
		],
	};

	test("resolves a state name case-insensitively", async () => {
		const { client } = makeFakeClient({ states });
		const resolver = new Resolver(client);
		expect(await resolver.resolveStateId(PROJECT.id, "backlog")).toBe("state-backlog");
	});

	test("returns undefined for unknown state", async () => {
		const { client } = makeFakeClient({ states });
		const resolver = new Resolver(client);
		expect(await resolver.resolveStateId(PROJECT.id, "Nope")).toBeUndefined();
	});
});

describe("Resolver.resolveAssigneeId", () => {
	test("matches by email when input looks like an email (flat member shape)", async () => {
		const members = {
			[PROJECT.id]: [{ id: "user-1", email: "jane@co.com", display_name: "jane" }],
		};
		const { client } = makeFakeClient({ members });
		const resolver = new Resolver(client);
		expect(await resolver.resolveAssigneeId(PROJECT.id, "jane@co.com")).toBe("user-1");
	});

	test("matches by display name when input is not an email (nested member shape)", async () => {
		const members = {
			[PROJECT.id]: [{ member: { id: "user-2", email: "bob@co.com", display_name: "bob" } }],
		};
		const { client } = makeFakeClient({ members });
		const resolver = new Resolver(client);
		expect(await resolver.resolveAssigneeId(PROJECT.id, "bob")).toBe("user-2");
	});

	test("returns undefined when no member matches", async () => {
		const members = { [PROJECT.id]: [{ id: "user-1", email: "jane@co.com" }] };
		const { client } = makeFakeClient({ members });
		const resolver = new Resolver(client);
		expect(await resolver.resolveAssigneeId(PROJECT.id, "ghost@co.com")).toBeUndefined();
	});

	test("passes through a UUID assignee", async () => {
		const { client } = makeFakeClient({ members: {} });
		const resolver = new Resolver(client);
		const uuid = "99999999-9999-4999-8999-999999999999";
		expect(await resolver.resolveAssigneeId(PROJECT.id, uuid)).toBe(uuid);
	});
});
