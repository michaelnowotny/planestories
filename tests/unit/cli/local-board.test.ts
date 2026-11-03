import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import {
	BOARD_CACHE_MAX_AGE_MS,
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	parseBoardCache,
	serializeBoardCache,
} from "../../../src/cli/board_cache.ts";

const BASE_URL = "http://127.0.0.1:1";
const WORKSPACE = "archimedes";
const PROJECT = {
	id: "11111111-1111-4111-8111-111111111111",
	identifier: "DATA",
	name: "Data Platform",
};
const FETCHED = new Date(Date.now() - 14 * 60_000).toISOString();

function storyNode(id: string, identifier: string, title: string, itemId: string): AtlasNode {
	return {
		id,
		kind: "story",
		title,
		identifier,
		url: `${BASE_URL}/${WORKSPACE}/projects/${PROJECT.id}/issues/${itemId}`,
		status: "Todo",
		statusGroup: "unstarted",
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

function cache(options: { records: boolean; fetchedAt?: string }): BoardCache {
	const child = storyNode("n-2", "DATA-2", "Child story", "story-2");
	const epic: AtlasNode = {
		...storyNode("n-1", "DATA-1", "Epic title", "epic-1"),
		kind: "epic",
		children: [child],
	};
	const graph: AtlasGraph = {
		project: PROJECT.name,
		source: "board",
		nodes: [epic],
		edges: [],
		labels: [],
		assignees: [],
		statuses: ["Todo"],
		counts: { epics: 1, stories: 1, criteria: 0, flagged: 0, edges: 0 },
	};
	const items = [
		{
			id: "epic-1",
			identifier: "DATA-1",
			title: "Epic title",
			updatedAt: "2026-08-02T00:00:00.000Z",
		},
		{
			id: "story-2",
			identifier: "DATA-2",
			title: "Child story",
			updatedAt: "2026-08-02T00:00:00.000Z",
		},
	];
	const value: BoardCache = {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt: options.fetchedAt ?? FETCHED,
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: items.length,
		items,
		dependencyCoverage: { kind: "complete" },
		graph,
	};
	if (options.records) {
		value.records = [
			{
				id: "epic-1",
				sequenceId: 1,
				name: "Epic title",
				descriptionHtml: "<p>Epic body.</p>",
				priority: null,
				point: null,
				stateName: "Todo",
				stateGroup: "unstarted",
				parentId: null,
				labelNames: [],
				assignee: null,
				externalSource: null,
				externalId: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-02T00:00:00.000Z",
			},
			{
				id: "story-2",
				sequenceId: 2,
				name: "Child story",
				descriptionHtml: "<p>Ship the cache.</p>",
				priority: null,
				point: null,
				stateName: "Todo",
				stateGroup: "unstarted",
				parentId: "epic-1",
				labelNames: [],
				assignee: null,
				externalSource: null,
				externalId: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-02T00:00:00.000Z",
			},
		];
		value.relations = {};
	}
	return value;
}

function writeWorkspace(value: BoardCache | null): string {
	const directory = mkdtempSync(join(tmpdir(), "planestories-local-board-"));
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
	if (value) {
		mkdirSync(join(directory, ".planestories"), { recursive: true });
		writeFileSync(join(directory, ".planestories", "board.json"), serializeBoardCache(value));
	}
	return directory;
}

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

test("a cache with records round-trips, and records without relations is refused", () => {
	const rich = cache({ records: true });
	expect(parseBoardCache(serializeBoardCache(rich))).toEqual(rich);

	const torn = { ...rich, relations: undefined };
	expect(() => parseBoardCache(JSON.stringify(torn))).toThrow(/records and relations/);
});

test("critical-path answers from a fresh cache and prints the absolute fetchedAt", () => {
	const directory = writeWorkspace(cache({ records: false }));
	try {
		const result = runCli(["critical-path"], directory);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`Source: board cache fetched ${FETCHED} — NOT live.`);
		expect(result.out).toContain("No dependency chain");
		expect(result.err).toContain(`Read from board cache (fetched ${FETCHED}) — NOT live.`);
		expect(result.err).not.toContain("ECONNREFUSED");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("critical-path --json carries the cache instant and leaves stdout machine-clean", () => {
	const directory = writeWorkspace(cache({ records: false }));
	try {
		const result = runCli(["critical-path", "--json"], directory);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out).source).toEqual({ kind: "cache", takenAt: FETCHED });
		expect(result.out).not.toContain("NOT live");
		expect(result.err).toContain(FETCHED);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("critical-path without a cache refuses and names board fetch", () => {
	const directory = writeWorkspace(null);
	try {
		const result = runCli(["critical-path"], directory);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("board fetch");
		expect(result.out).not.toContain("No dependency chain");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a stale critical-path cache is refused unless --stale-ok", () => {
	const fetchedAt = new Date(Date.now() - 2 * BOARD_CACHE_MAX_AGE_MS).toISOString();
	const directory = writeWorkspace(cache({ records: false, fetchedAt }));
	try {
		const refused = runCli(["critical-path"], directory);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("--stale-ok");

		const accepted = runCli(["critical-path", "--stale-ok"], directory);
		expect(accepted.code).toBe(0);
		expect(accepted.out).toContain(fetchedAt);
		expect(accepted.err).toContain("--stale-ok");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("critical-path --refresh cannot be combined with a file or --from-snapshot", () => {
	const directory = writeWorkspace(null);
	try {
		const file = runCli(["critical-path", "stories.md", "--refresh"], directory);
		expect(file.code).not.toBe(0);
		expect(file.err).toContain("cannot be combined");

		const snapshot = runCli(
			["critical-path", "--from-snapshot", "missing.json", "--refresh"],
			directory,
		);
		expect(snapshot.code).not.toBe(0);
		expect(snapshot.err).toContain("cannot be combined");
		expect(snapshot.err).not.toContain("not found");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("packet, epic, and doctor answer offline from cached records and print fetchedAt", () => {
	const directory = writeWorkspace(cache({ records: true }));
	try {
		const packet = runCli(["packet", "DATA-2"], directory);
		expect(packet.code).toBe(0);
		expect(packet.out).toContain("Ship the cache");
		expect(packet.out).toContain("DATA-2");
		expect(packet.out).not.toContain("NOT live");
		expect(packet.err).toContain(`Read from board cache (fetched ${FETCHED}) — NOT live.`);

		const epic = runCli(["epic", "DATA-1"], directory);
		expect(epic.code).toBe(0);
		expect(epic.out).toContain("DATA-1 — Epic title");
		expect(epic.out).toContain("Stories: 1");
		expect(epic.err).toContain(FETCHED);

		const doctor = runCli(["doctor", "--json"], directory);
		expect(doctor.code).toBe(0);
		const report = JSON.parse(doctor.out);
		expect(report.source).toEqual({ kind: "cache", takenAt: FETCHED });
		expect(report.findings).toBe(0);
		expect(doctor.out).not.toContain("NOT live");
		expect(doctor.err).toContain(`Read from board cache (fetched ${FETCHED}) — NOT live.`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("packet, epic, and doctor refuse a graph-only cache instead of guessing or going live", () => {
	const directory = writeWorkspace(cache({ records: false }));
	try {
		for (const args of [["packet", "DATA-1"], ["epic", "DATA-1"], ["doctor"]]) {
			const result = runCli(args, directory);
			expect(result.code, args.join(" ")).not.toBe(0);
			expect(result.err, args.join(" ")).toContain("work-item records");
			expect(result.err, args.join(" ")).toContain("board fetch");
			expect(result.out, args.join(" ")).not.toContain("Ship the cache");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stale packet and epic caches answer only with --stale-ok", () => {
	const fetchedAt = new Date(Date.now() - 2 * BOARD_CACHE_MAX_AGE_MS).toISOString();
	const directory = writeWorkspace(cache({ records: true, fetchedAt }));
	try {
		const refused = runCli(["packet", "DATA-2"], directory);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("--refresh");

		const packet = runCli(["packet", "DATA-2", "--stale-ok"], directory);
		expect(packet.code).toBe(0);
		expect(packet.out).toContain("Ship the cache");
		expect(packet.err).toContain(fetchedAt);

		const epic = runCli(["epic", "DATA-1", "--stale-ok"], directory);
		expect(epic.code).toBe(0);
		expect(epic.out).toContain("Stories: 1");

		const doctor = runCli(["doctor", "--stale-ok", "--json"], directory);
		expect(doctor.code).toBe(0);
		expect(JSON.parse(doctor.out).source.takenAt).toBe(fetchedAt);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("packet, epic, and doctor reject --refresh together with --from-snapshot", () => {
	const directory = writeWorkspace(null);
	try {
		for (const args of [
			["packet", "DATA-1", "--from-snapshot", "missing.json", "--refresh"],
			["epic", "DATA-1", "--from-snapshot", "missing.json", "--refresh"],
			["doctor", "--from-snapshot", "missing.json", "--refresh"],
		]) {
			const result = runCli(args, directory);
			expect(result.code, args.join(" ")).not.toBe(0);
			expect(result.err, args.join(" ")).toContain("cannot be combined");
			expect(result.err, args.join(" ")).not.toContain("not found");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
