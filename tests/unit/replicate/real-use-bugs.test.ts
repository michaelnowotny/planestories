import { describe, expect, test } from "bun:test";
import { renameProject } from "../../../src/cli/commands/rename-project.ts";
import { PlaneApiError } from "../../../src/errors.ts";
import { createPlaneClient } from "../../../src/plane/client.ts";
import { decideGate } from "../../../src/replicate/gate.ts";
import { sampleSnapshot } from "./fixtures.ts";

/**
 * Bugs found by the finance session's real cutover, 2026-08-16/17. Each test is
 * written against the behaviour a user actually hit, not a hypothetical.
 */

describe("rename-project: an applied rename must never be reported as a failure", () => {
	// Real incident: the rename SUCCEEDED (cloud immediately listed DATAX) while the
	// command raised "400 Bad Request". A false failure is the dangerous direction —
	// it invites a destructive retry. Cause: the client replays transient failures, so
	// a PATCH that applied but hiccupped in transport is re-sent, and the replay fails
	// 400 "identifier already in use" — taken by the project itself.
	function clientWhereRenameAlreadyApplied() {
		let listCalls = 0;
		return {
			listProjects: async <T>(): Promise<T[]> => {
				listCalls++;
				// First read: the pre-rename world. Any read after the failed PATCH
				// shows the rename already in place (the first attempt applied it).
				return (
					listCalls === 1
						? [{ id: "p1", name: "Data Platform", identifier: "DATA" }]
						: [{ id: "p1", name: "Data Platform", identifier: "DATAX" }]
				) as T[];
			},
			updateProject: async <T>(): Promise<T> => {
				throw new PlaneApiError("The project identifier is already taken", 400);
			},
		};
	}

	test("a 400 whose desired state is already live reports success, not failure", async () => {
		const result = await renameProject(clientWhereRenameAlreadyApplied(), {
			project: "DATA",
			identifier: "DATAX",
			yes: true,
		});
		expect(result.proposed.identifier).toBe("DATAX");
		expect(result.alreadyApplied).toBe(true);
	});

	test("a 400 whose desired state is NOT live still fails loudly", async () => {
		const client = {
			listProjects: async <T>(): Promise<T[]> =>
				[
					{ id: "p1", name: "Data Platform", identifier: "DATA" },
					{ id: "p2", name: "Other", identifier: "TAKEN" },
				] as T[],
			updateProject: async <T>(): Promise<T> => {
				throw new PlaneApiError("The project identifier is already taken", 400);
			},
		};
		await expect(
			renameProject(client, { project: "DATA", identifier: "TAKEN", yes: true }),
		).rejects.toThrow(/already in use|invalid/i);
	});
});

describe("gate: the destination NAME must be checked before any write", () => {
	// Real incident: freeing the identifier left the old project still NAMED
	// "Data Platform", so the apply died mid-flight on a raw
	// 409 {"name":"The project name is already taken"} from Plane instead of
	// failing closed in the gate where every other precondition lives.
	const snapshot = sampleSnapshot();

	function gateWith(nameAvailable: boolean) {
		return decideGate({
			snapshot,
			destIdentifier: snapshot.project.identifier,
			destName: snapshot.project.name,
			probe: {
				dialect: "issues",
				identifierAvailable: true,
				nameAvailable,
				existingProjectId: null,
				memberByEmail: {},
				sequencesMaxEver: true,
				createdAtAccepted: true,
				createdByAccepted: true,
				commentCreatedAtAccepted: true,
				archivedEndpoint: "listed",
				archiveVerb: true,
				rejectedRelationKinds: [],
			},
			flags: {},
			resume: { journalOwnsProject: null },
		} as never);
	}

	test("a taken destination name is a gate error, naming the remedy", () => {
		const decision = gateWith(false);
		expect(decision.ok).toBe(false);
		expect(decision.errors.join(" ")).toMatch(/name/i);
	});

	test("an available destination name passes", () => {
		expect(gateWith(true).ok).toBe(true);
	});
});

describe("archived list: try the canonical spelling before concluding 'unavailable'", () => {
	// Real incident: cloud serves `archived-work-items/` (200) and 404s
	// `archived-issues/`. Because the path was derived from the ITEMS dialect, an
	// issues-dialect source reported "endpoint unavailable" — discarding a definitive
	// answer and leaving verify with an unnecessary caveat.
	async function withStubbedFetch<T>(
		handler: (url: string) => Response,
		run: (asked: string[]) => Promise<T>,
	): Promise<T> {
		const asked: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			asked.push(url);
			return handler(url);
		}) as typeof fetch;
		try {
			return await run(asked);
		} finally {
			globalThis.fetch = original;
		}
	}

	const page = () =>
		new Response(JSON.stringify({ results: [], next_page_results: false }), { status: 200 });

	test("an issues-dialect client still finds the work-items archived endpoint", async () => {
		await withStubbedFetch(
			(url) => (url.includes("archived-work-items") ? page() : new Response("", { status: 404 })),
			async (asked) => {
				const client = createPlaneClient({
					apiKey: "k",
					workspaceSlug: "ws",
					baseUrl: "https://example.invalid",
					maxRetries: 0,
					dialect: "issues",
				});
				expect(await client.listArchivedWorkItems("p1")).not.toBeNull();
				expect(asked.some((u) => u.includes("archived-work-items"))).toBe(true);
			},
		);
	});

	test("null is returned only when NO spelling answers", async () => {
		await withStubbedFetch(
			() => new Response("", { status: 404 }),
			async () => {
				const client = createPlaneClient({
					apiKey: "k",
					workspaceSlug: "ws",
					baseUrl: "https://example.invalid",
					maxRetries: 0,
					dialect: "work-items",
				});
				expect(await client.listArchivedWorkItems("p1")).toBeNull();
			},
		);
	});
});
