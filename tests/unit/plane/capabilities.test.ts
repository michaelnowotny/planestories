import { describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import {
	formatCapabilitiesTable,
	probeDeploymentCapabilities,
} from "../../../src/plane/capabilities.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "../../../src/plane/client.ts";

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
				relations: "throws",
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
