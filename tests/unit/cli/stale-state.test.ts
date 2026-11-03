import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import {
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	type BoardCacheComment,
	serializeBoardCache,
} from "../../../src/cli/board_cache.ts";

const BASE_URL = "http://127.0.0.1:1";
const WORKSPACE = "archimedes";
const PROJECT = {
	id: "11111111-1111-4111-8111-111111111111",
	identifier: "DATA",
	name: "Data Platform",
};

function runCli(args: string[], cwd: string): { code: number; out: string; err: string } {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	const env: Record<string, string> = { FORCE_COLOR: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawnSync(["bun", "run", cli, ...args], { env, cwd });
	return {
		code: proc.exitCode ?? -1,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function node(sequence: number, title: string, statusGroup: AtlasNode["statusGroup"]): AtlasNode {
	return {
		id: `n-${sequence}`,
		kind: "story",
		title,
		identifier: `DATA-${sequence}`,
		url: `${BASE_URL}/${WORKSPACE}/projects/${PROJECT.id}/issues/item-${sequence}`,
		status: statusGroup === "completed" ? "Done" : "Todo",
		statusGroup,
		labels: [],
		assignee: null,
		effortDays: null,
		priority: null,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
		criteria: [],
		quality: { ok: true, flags: [] },
		children: [],
	};
}

function comment(id: string, html: string, createdAt: string): BoardCacheComment {
	return { id, commentHtml: html, createdAt, createdBy: null };
}

function writeCache(value: BoardCache): string {
	const directory = mkdtempSync(join(tmpdir(), "planestories-stale-state-"));
	mkdirSync(join(directory, ".git"), { recursive: true });
	writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/test\n");
	writeFileSync(
		join(directory, ".planestoriesrc.json"),
		JSON.stringify({
			apiKey: "plane_api_test",
			workspaceSlug: WORKSPACE,
			baseUrl: BASE_URL,
			dialect: "issues",
			defaultProject: PROJECT.name,
		}),
	);
	mkdirSync(join(directory, ".planestories"), { recursive: true });
	writeFileSync(join(directory, ".planestories", "board.json"), serializeBoardCache(value));
	return directory;
}

function capturedCache(now: Date): { cache: BoardCache; fetchedAt: string } {
	const fetchedAt = new Date(now.getTime() - 14 * 60_000).toISOString();
	const recent = new Date(now.getTime() - 60_000).toISOString();
	const old = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
	const older = new Date(now.getTime() - 40 * 24 * 60 * 60_000).toISOString();
	const specs: Array<{
		sequence: number;
		title: string;
		group: AtlasNode["statusGroup"];
		comments: BoardCacheComment[];
	}> = [
		{
			sequence: 1,
			title: "Old deploy",
			group: "unstarted",
			comments: [comment("c1", "<p>deployed</p>", old)],
		},
		{
			sequence: 2,
			title: "Shouted done",
			group: "started",
			comments: [comment("c2", "<p>DONE</p>", recent)],
		},
		{
			sequence: 3,
			title: "Merge note",
			group: "backlog",
			comments: [comment("c3", "<p>merged</p>", recent)],
		},
		{
			sequence: 4,
			title: "Ship note",
			group: "unstarted",
			comments: [comment("c4", "<p>shipped</p>", recent)],
		},
		{
			sequence: 5,
			title: "Release note",
			group: "unstarted",
			comments: [comment("c5", "<p>released</p>", recent)],
		},
		{
			sequence: 6,
			title: "Close note",
			group: "unknown",
			comments: [comment("c6", "<p>closed</p>", recent)],
		},
		{
			sequence: 8,
			title: "COMPLETED MERGED ITEM",
			group: "completed",
			comments: [comment("c8", "<p>merged</p>", recent)],
		},
		{
			sequence: 9,
			title: "Superseded merge note",
			group: "unstarted",
			comments: [
				comment("c9a", "<p>merged</p>", older),
				comment("c9b", "<p>still working</p>", recent),
			],
		},
		{
			sequence: 10,
			title: "Negated done",
			group: "unstarted",
			comments: [comment("c10", "<p>not done yet</p>", recent)],
		},
	];
	const nodes = specs.map((spec) => node(spec.sequence, spec.title, spec.group));
	const graph: AtlasGraph = {
		project: PROJECT.name,
		source: "board",
		nodes,
		edges: [],
		labels: [],
		assignees: [],
		statuses: ["Todo", "Done"],
		counts: { epics: 0, stories: nodes.length, criteria: 0, flagged: 0, edges: 0 },
	};
	const cache: BoardCache = {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt,
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: nodes.length,
		items: nodes.map((entry) => ({
			id: entry.url?.split("/").at(-1) ?? "",
			identifier: entry.identifier ?? "",
			title: entry.title,
			updatedAt: entry.updatedAt,
		})),
		dependencyCoverage: { kind: "complete" },
		graph,
		commentInventory: "captured",
		comments: Object.fromEntries(specs.map((spec) => [`item-${spec.sequence}`, spec.comments])),
	};
	return { cache, fetchedAt };
}

test("audit --stale-state lists open items whose latest comment looks finished", () => {
	const now = new Date();
	const { cache, fetchedAt } = capturedCache(now);
	const directory = writeCache(cache);
	try {
		const result = runCli(["audit", "--stale-state"], directory);
		expect(result.code).toBe(0);
		expect(result.out).toContain("Heuristic:");
		expect(result.out).toContain("not a state change");
		expect(result.out).toContain(fetchedAt);
		expect(result.err).toContain(fetchedAt);
		expect(result.err).not.toContain("ECONNREFUSED");
		const expected: Array<[string, string]> = [
			["DATA-1", "deployed"],
			["DATA-2", "done"],
			["DATA-3", "merged"],
			["DATA-4", "shipped"],
			["DATA-5", "released"],
			["DATA-6", "closed"],
		];
		for (const [identifier, word] of expected) {
			expect(result.out).toContain(identifier);
			expect(result.out).toContain(`matched ${word}`);
		}
		expect(result.out).not.toContain("COMPLETED MERGED ITEM");
		expect(result.out).not.toContain("Superseded merge note");
		expect(result.out).not.toContain("Negated done");
		expect(result.out).toContain("Candidates: 6");

		const json = runCli(["audit", "--stale-state", "--json"], directory);
		expect(json.code).toBe(0);
		const payload = JSON.parse(json.out);
		expect(payload.heuristic).toBe(true);
		expect(payload.candidates).toHaveLength(6);
		expect(json.out).not.toContain("COMPLETED MERGED ITEM");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("audit --stale-state --since keeps only a latest comment inside the window", () => {
	const now = new Date();
	const directory = writeCache(capturedCache(now).cache);
	try {
		const result = runCli(["audit", "--stale-state", "--since", "1h"], directory);
		expect(result.code).toBe(0);
		expect(result.out).toContain("Window:");
		expect(result.out).not.toContain("DATA-1");
		expect(result.out).toContain("DATA-2");
		expect(result.out).toContain("matched done");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("audit --stale-state refuses a cache that did not capture comments", () => {
	const fetchedAt = new Date(Date.now() - 14 * 60_000).toISOString();
	const story = node(1, "No comments", "unstarted");
	const cache: BoardCache = {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt,
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: 1,
		items: [
			{
				id: "item-1",
				identifier: "DATA-1",
				title: story.title,
				updatedAt: story.updatedAt,
			},
		],
		dependencyCoverage: { kind: "complete" },
		graph: {
			project: PROJECT.name,
			source: "board",
			nodes: [story],
			edges: [],
			labels: [],
			assignees: [],
			statuses: ["Todo"],
			counts: { epics: 0, stories: 1, criteria: 0, flagged: 0, edges: 0 },
		},
		commentInventory: "not-requested",
	};
	const directory = writeCache(cache);
	try {
		const result = runCli(["audit", "--stale-state"], directory);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("board fetch --with-comments");
		expect(result.out).not.toContain("Candidates:");
		expect(result.out).not.toContain("0 comments");
		expect(result.err).not.toContain("ECONNREFUSED");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
