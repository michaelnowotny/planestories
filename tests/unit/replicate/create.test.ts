import { describe, expect, test } from "bun:test";
import { PlaneApiError, ReplicateError } from "../../../src/errors.ts";
import { createItemA10 } from "../../../src/replicate/create.ts";
import { FakePlane } from "./fake-plane.ts";

async function setup() {
	const fake = new FakePlane();
	const project = await fake.createProject<{ id: string }>({ name: "Test", identifier: "TST" });
	return { fake, projectId: project.id };
}

describe("A10 item create", () => {
	test("passes through a successful create and disables client retries", async () => {
		const { fake, projectId } = await setup();
		let seen: number | undefined;
		const original = fake.createWorkItem.bind(fake);
		fake.createWorkItem = async <T>(
			p: string,
			b: Record<string, unknown>,
			opts?: { maxRetries?: number },
		) => {
			seen = opts?.maxRetries;
			return original<T>(p, b, opts);
		};
		const out = await createItemA10(
			fake,
			projectId,
			{ name: "Expected" },
			{ sequence: 1, name: "Expected" },
		);
		expect(out).toEqual({ id: expect.any(String), sequenceId: 1, adopted: false });
		expect(seen).toBe(0);
	});

	test("adopts an ambiguous committed write after exactly one POST", async () => {
		const { fake, projectId } = await setup();
		fake.failNextCreate = "ambiguous-committed";
		const out = await createItemA10(
			fake,
			projectId,
			{ name: "Expected" },
			{ sequence: 1, name: "Expected" },
		);
		expect(out.adopted).toBeTrue();
		expect(fake.createCalls).toBe(1);
	});

	test("retries a verified-lost transient create within the bounded budget", async () => {
		const { fake, projectId } = await setup();
		fake.failNextCreate = "ambiguous-lost";
		const out = await createItemA10(
			fake,
			projectId,
			{ name: "Expected" },
			{ sequence: 1, name: "Expected" },
			{ sleep: async () => {} },
		);
		expect(out.sequenceId).toBe(1);
		expect(fake.createCalls).toBe(2);
	});

	test("fails closed when a foreign fingerprint occupies the expected sequence", async () => {
		const { fake, projectId } = await setup();
		await fake.createWorkItem(projectId, { name: "Foreign" });
		fake.failNextCreate = "ambiguous-lost";
		await expect(
			createItemA10(fake, projectId, { name: "Expected" }, { sequence: 1, name: "Expected" }),
		).rejects.toBeInstanceOf(ReplicateError);
		expect(fake.createCalls).toBe(2);
	});

	test("permanent 4xx is rethrown without a replay", async () => {
		const { fake, projectId } = await setup();
		fake.failNextCreate = "permanent";
		await expect(
			createItemA10(fake, projectId, { name: "Expected" }, { sequence: 1, name: "Expected" }),
		).rejects.toThrow("bad request");
		expect(fake.createCalls).toBe(1);
	});

	test("a reconcile-list failure rethrows the original create error without replay", async () => {
		const { fake, projectId } = await setup();
		fake.failNextCreate = "ambiguous-lost";
		fake.failNextList = true;
		try {
			await createItemA10(fake, projectId, { name: "Expected" }, { sequence: 1, name: "Expected" });
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(PlaneApiError);
			expect((error as Error).message).toContain("ambiguous network failure");
		}
		expect(fake.createCalls).toBe(1);
	});
});
