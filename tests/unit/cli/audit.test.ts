import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph } from "../../../src/atlas/model.ts";
import {
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	serializeBoardCache,
} from "../../../src/cli/board_cache.ts";
import { runAudit } from "../../../src/cli/commands/audit.ts";
import { RequiredBoardCacheError } from "../../../src/cli/graph_source.ts";
import { formatAuditReport } from "../../../src/sync/audit.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const PROJECT = {
	id: "project-1",
	identifier: "DATA",
	name: "Data Platform",
};
const BASE_URL = "https://api.plane.so";
const WORKSPACE = "ws";

let directory: string;
let configPath: string;
let cachePath: string;
const savedPlaneEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-audit-"));
	configPath = join(directory, ".planestoriesrc.json");
	cachePath = join(directory, ".planestories", "board.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			apiKey: "plane_api_test",
			workspaceSlug: WORKSPACE,
			baseUrl: BASE_URL,
			dialect: "issues",
			defaultProject: PROJECT.name,
		}),
	);
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) {
			savedPlaneEnv[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedPlaneEnv)) {
		if (value !== undefined) process.env[key] = value;
		delete savedPlaneEnv[key];
	}
});

function graph(): AtlasGraph {
	return {
		project: PROJECT.name,
		source: "board",
		nodes: [
			{
				id: "n-1",
				kind: "story",
				title: "Visible story",
				identifier: "DATA-1",
				url: "https://app.plane.so/ws/projects/project-1/issues/inside",
				status: "Todo",
				statusGroup: "unstarted",
				labels: [],
				assignee: null,
				effortDays: null,
				priority: null,
				createdAt: "2026-08-20T00:00:00.000Z",
				updatedAt: "2026-08-23T11:00:00.000Z",
				criteria: [{ text: "Legacy criterion", checked: false }],
				quality: { ok: true, flags: [] },
				children: [],
			},
		],
		edges: [],
		labels: [],
		assignees: [],
		statuses: ["Todo"],
		counts: { epics: 0, stories: 1, criteria: 1, flagged: 0, edges: 0 },
	};
}

function cache(): BoardCache {
	return {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt: "2026-08-23T11:46:00.000Z",
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: 3,
		items: [
			{
				id: "inside",
				identifier: "DATA-1",
				title: "Visible story",
				updatedAt: "2026-08-23T11:00:00.000Z",
			},
			{
				id: "legacy-criterion",
				identifier: "DATA-2",
				title: "Legacy criterion child",
				updatedAt: "2026-08-23T11:30:00.000Z",
			},
			{
				id: "outside",
				identifier: "DATA-3",
				title: "Outside window",
				updatedAt: "2026-08-23T08:00:00.000Z",
			},
		],
		dependencyCoverage: { kind: "complete" },
		graph: graph(),
	};
}

function writeCache(): void {
	mkdirSync(join(directory, ".planestories"), { recursive: true });
	writeFileSync(cachePath, serializeBoardCache(cache()));
}

describe("runAudit", () => {
	test("uses the cache's all-item inventory, including a folded criterion child", async () => {
		writeCache();
		const announcements: string[] = [];
		const fake = makeFakeClient({
			currentUser: { id: "actor-me", display_name: "Operator" },
			activities: {
				inside: [
					{
						id: "activity-1",
						actor: "actor-me",
						verb: "updated",
						field: "state",
						created_at: "2026-08-23T11:10:00Z",
					},
				],
				"legacy-criterion": [
					{
						id: "activity-2",
						actor: "actor-me",
						verb: "updated",
						field: "name",
						created_at: "2026-08-23T11:40:00Z",
					},
				],
			},
		});

		const result = await runAudit(
			{ config: configPath, since: "2h", json: true },
			{
				now: () => NOW,
				graphSource: { cachePath, log: () => {}, warn: () => {} },
				connectTarget: async (config) => ({ config, client: fake.client }),
				announceTarget: (config, context, project) =>
					announcements.push(`${config.baseUrl}|${context ?? "default"}|${project ?? ""}`),
			},
		);

		expect(result.report.walkedItemCount).toBe(2);
		expect(result.report.writes.map((write) => write.identifier)).toEqual(["DATA-2", "DATA-1"]);
		expect(result.report.writes.every((write) => write.instance === BASE_URL)).toBe(true);
		expect(result.report.provenance).toMatchObject({
			instance: BASE_URL,
			workspaceSlug: WORKSPACE,
			project: PROJECT.name,
			projectId: PROJECT.id,
			cacheAgeMs: 14 * 60_000,
		});
		expect(announcements).toEqual([`${BASE_URL}|default|${PROJECT.name}`]);
		expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(false);
		const human = formatAuditReport(result.report);
		expect(human).toContain(`Board: ${PROJECT.name} · ${BASE_URL} · workspace ${WORKSPACE}`);
		expect(human).toContain("14m old");
		expect(human).toContain("walked 2/3 cached items");
		expect(human).toContain("which tool made them");
		expect(human).toContain("covers only the --since window");
		expect(result.report.limits.candidateNarrowing).toContain("comment- or relation-only");
	});

	test("a missing required cache refuses before connecting live and names board fetch", async () => {
		let connected = false;
		try {
			await runAudit(
				{ config: configPath, since: "2h" },
				{
					now: () => NOW,
					graphSource: { cachePath, log: () => {}, warn: () => {} },
					connectTarget: async () => {
						connected = true;
						throw new Error("must not connect");
					},
				},
			);
			throw new Error("expected required-cache refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(RequiredBoardCacheError);
			expect((error as Error).message).toContain("planestories board fetch");
			expect((error as Error).message).toContain(PROJECT.name);
		}
		expect(connected).toBe(false);
	});
});

test("audit is registered with the required public options", () => {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	const result = Bun.spawnSync(["bun", "run", cli, "audit", "--help"], {
		cwd: directory,
		env: { ...process.env, FORCE_COLOR: "0" },
	});
	const output = result.stdout.toString();

	expect(result.exitCode).toBe(0);
	expect(output).toContain("--since <duration|iso>");
	expect(output).toContain("--context <name>");
	expect(output).toContain("--json");
});
