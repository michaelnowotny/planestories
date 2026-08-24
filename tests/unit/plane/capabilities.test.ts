import { describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import {
	formatCapabilitiesTable,
	probeDeploymentCapabilities,
} from "../../../src/plane/capabilities.ts";
import type {
	PlaneEndpointDialect,
	PlaneIssueRelations,
	RelationMethodProbe,
} from "../../../src/plane/client.ts";

/** Plane answers OPTIONS with 405 but still sets `Allow` — that header is the measurement. */
const COLLECTION_GET_POST = { status: 405, allow: ["GET", "POST"] };
/** Both known removal routes returning 404 with no Allow: the routes do not exist. */
const REMOVAL_ABSENT = [
	{ status: 404, allow: [] },
	{ status: 404, allow: [] },
];
const REMOVAL_PRESENT = [
	{ status: 405, allow: ["POST"] },
	{ status: 404, allow: [] },
];

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

function stub(options: {
	dialect: PlaneEndpointDialect;
	edition: string;
	version: string;
	pql: "supported" | "unsupported" | "throws";
	count: "supported" | "unsupported" | "throws";
	relations?: "supported" | "throws";
	relationMethods?: RelationMethodProbe | "throws";
}) {
	return {
		baseUrl: "https://plane.example",
		workspaceSlug: "archimedes",
		dialect: options.dialect,
		async getInstance<T>(): Promise<T> {
			return {
				instance: { edition: options.edition, current_version: options.version },
			} as T;
		},
		async listProjects<T>(): Promise<T[]> {
			return [{ id: "project-1", name: "Data Platform", identifier: "DATA" }] as T[];
		},
		async sampleWorkItem<T>(): Promise<T | null> {
			return { id: "item-1" } as T;
		},
		async getRelations(): Promise<PlaneIssueRelations> {
			if (options.relations === "throws") throw new Error("relations unavailable");
			return EMPTY_RELATIONS;
		},
		async probeRelationMethods(): Promise<RelationMethodProbe> {
			if (options.relationMethods === "throws") throw new Error("OPTIONS probe failed");
			return (
				options.relationMethods ?? {
					collection: COLLECTION_GET_POST,
					removal: options.dialect === "work-items" ? REMOVAL_ABSENT : REMOVAL_PRESENT,
				}
			);
		},
		async probePql(): Promise<void> {
			if (options.pql === "unsupported") {
				throw new PlaneApiError(
					'Plane API GET failed (400 Bad Request): {"pql":"PQL is not supported","unsupported_parameters":["pql"]}',
					400,
				);
			}
			if (options.pql === "throws") throw new Error("PQL probe failed");
		},
		async probeWorkspaceCount(): Promise<void> {
			if (options.count === "unsupported") {
				throw new PlaneApiError("Plane API GET failed (404 Not Found)", 404);
			}
			if (options.count === "throws") throw new Error("count probe failed");
		},
	};
}

describe("deployment capabilities", () => {
	test("CE reports every negative explicitly", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "work-items",
				edition: "PLANE_COMMUNITY",
				version: "1.4.1",
				pql: "unsupported",
				count: "unsupported",
			}),
			{ dialectSource: "detected", preferredProject: "Data Platform" },
		);

		expect(result.capabilities).toEqual({
			relationCreate: "supported",
			relationList: "supported",
			relationRemove: "not-supported",
			pql: "not-supported",
			countEndpoint: "not-supported",
		});
		const table = formatCapabilitiesTable(result);
		expect(table).toContain("relation removal");
		expect(table).toContain("NOT SUPPORTED on this deployment");
		expect(table).toContain("PQL");
		expect(table).toContain("count endpoint");
	});

	test("Cloud reports the same rows as supported", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "issues",
				edition: "PLANE_CLOUD",
				version: "2.6.0",
				pql: "supported",
				count: "supported",
			}),
			{ dialectSource: "configured" },
		);

		expect(result.capabilities).toEqual({
			relationCreate: "supported",
			relationList: "supported",
			relationRemove: "supported",
			pql: "supported",
			countEndpoint: "supported",
		});
	});

	test("a failed probe is indeterminate, never reported as unsupported", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "issues",
				edition: "PLANE_CLOUD",
				version: "2.6.0",
				pql: "throws",
				count: "throws",
				// The relation surface is probed by OPTIONS now, not by a list GET.
				relationMethods: "throws",
			}),
			{ dialectSource: "fallback" },
		);

		expect(result.capabilities).toEqual({
			relationCreate: "could-not-determine",
			relationList: "could-not-determine",
			relationRemove: "could-not-determine",
			pql: "could-not-determine",
			countEndpoint: "could-not-determine",
		});
		const table = formatCapabilitiesTable(result);
		expect(table).toContain("could not determine");
		expect(table).not.toContain("NOT SUPPORTED");
	});

	test("JSON data preserves indeterminate states and nullable instance facts", async () => {
		const client = stub({
			dialect: "issues",
			edition: "PLANE_CLOUD",
			version: "2.6.0",
			pql: "supported",
			count: "supported",
		});
		client.getInstance = async <T>() => ({ instance: {} }) as T;
		const result = await probeDeploymentCapabilities(client, { dialectSource: "configured" });
		const json = JSON.parse(JSON.stringify(result));
		expect(json.edition).toBeNull();
		expect(json.version).toBeNull();
		expect(json.capabilities).toEqual(result.capabilities);
	});

	test("an instance-metadata request failure leaves edition and version unknown", async () => {
		const client = stub({
			dialect: "issues",
			edition: "PLANE_CLOUD",
			version: "2.6.0",
			pql: "supported",
			count: "supported",
		});
		client.getInstance = async <T>(): Promise<T> => {
			throw new Error("instances endpoint unavailable");
		};
		const result = await probeDeploymentCapabilities(client, {
			dialectSource: "configured",
		});

		expect(result.edition).toBeNull();
		expect(result.version).toBeNull();
		const table = formatCapabilitiesTable(result);
		expect(table).toContain("edition: could not determine");
		expect(table).toContain("version: could not determine");
	});
});

/**
 * Relation create/list/remove used to be INFERRED: a successful list GET meant
 * create works, and `client.dialect === "work-items"` meant removal does not.
 * In the one command whose entire purpose is refusing to make confident claims
 * from indirect evidence, that was the wrong shape — a Cloud deployment with an
 * explicitly configured work-items dialect would have been told
 * "relation removal: NOT SUPPORTED" by a check that measured nothing.
 *
 * They are measured now, read-only. Plane rejects OPTIONS with
 * `405 Method "OPTIONS" not allowed` and still returns `Allow: GET, POST`; the
 * removal routes answer 404 with no `Allow` at all. Both are real statements,
 * and neither writes — which matters, because the obvious way to find out
 * whether removal works is to remove something.
 */
describe("relation capabilities are measured, not inferred from the dialect", () => {
	test("the dialect does not decide removal: work-items + a live route reports SUPPORTED", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "work-items",
				edition: "PLANE_COMMUNITY",
				version: "1.4.1",
				pql: "unsupported",
				count: "unsupported",
				relationMethods: {
					collection: COLLECTION_GET_POST,
					removal: [
						{ status: 405, allow: ["POST"] },
						{ status: 404, allow: [] },
					],
				},
			}),
			{ dialectSource: "configured" },
		);

		expect(result.capabilities.relationRemove).toBe("supported");
	});

	test("...and issues + absent routes reports NOT SUPPORTED", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "issues",
				edition: "PLANE_CLOUD",
				version: "2.6.0",
				pql: "supported",
				count: "supported",
				relationMethods: {
					collection: COLLECTION_GET_POST,
					removal: [
						{ status: 404, allow: [] },
						{ status: 404, allow: [] },
					],
				},
			}),
			{ dialectSource: "configured" },
		);

		expect(result.capabilities.relationRemove).toBe("not-supported");
	});

	test("an endpoint that does not state Allow is indeterminate, never a negative", async () => {
		// Silence is not a measurement. The old code could not tell these apart,
		// because it never asked the endpoint anything about create or remove.
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "issues",
				edition: "PLANE_CLOUD",
				version: "2.6.0",
				pql: "supported",
				count: "supported",
				relationMethods: {
					collection: { status: 200, allow: [] },
					removal: [{ status: 403, allow: [] }],
				},
			}),
			{ dialectSource: "configured" },
		);

		expect(result.capabilities.relationCreate).toBe("could-not-determine");
		expect(result.capabilities.relationList).toBe("could-not-determine");
		expect(result.capabilities.relationRemove).toBe("could-not-determine");
	});

	test("a collection that allows GET but not POST reports create unsupported", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "issues",
				edition: "PLANE_CLOUD",
				version: "2.6.0",
				pql: "supported",
				count: "supported",
				relationMethods: {
					collection: { status: 405, allow: ["GET"] },
					removal: REMOVAL_ABSENT,
				},
			}),
			{ dialectSource: "configured" },
		);

		expect(result.capabilities.relationList).toBe("supported");
		expect(result.capabilities.relationCreate).toBe("not-supported");
	});

	test("a failed OPTIONS probe leaves all three indeterminate", async () => {
		const result = await probeDeploymentCapabilities(
			stub({
				dialect: "work-items",
				edition: "PLANE_COMMUNITY",
				version: "1.4.1",
				pql: "unsupported",
				count: "unsupported",
				relationMethods: "throws",
			}),
			{ dialectSource: "detected" },
		);

		expect(result.capabilities.relationCreate).toBe("could-not-determine");
		expect(result.capabilities.relationRemove).toBe("could-not-determine");
	});
});
