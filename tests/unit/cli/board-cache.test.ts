import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph } from "../../../src/atlas/model.ts";
import {
	BOARD_CACHE_MAX_AGE_MS,
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	defaultBoardCachePath,
	parseBoardCache,
	serializeBoardCache,
	writeBoardCacheAtomic,
} from "../../../src/cli/board_cache.ts";
import { fetchBoardToCache } from "../../../src/cli/commands/board.ts";
import {
	type GraphSourceRuntime,
	RequiredBoardCacheError,
	resolveGraph,
	StaleBoardCacheError,
} from "../../../src/cli/graph_source.ts";
import type { PlaneClient } from "../../../src/plane/client.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const NOW = "2026-08-23T12:00:00.000Z";
const BASE_URL = "https://plane.example.test";
const WORKSPACE = "archimedes";
const PROJECT = {
	id: "11111111-1111-4111-8111-111111111111",
	identifier: "DATA",
	name: "Data Platform",
};

let directory: string;
let configPath: string;
let cachePath: string;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-board-cache-"));
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
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) delete process.env[key];
	}
	for (const [key, value] of Object.entries(SAVED)) {
		if (value !== undefined) process.env[key] = value;
		delete SAVED[key];
	}
});

function graph(title = "Cached title", projectName = PROJECT.name): AtlasGraph {
	return {
		project: projectName,
		source: "board",
		nodes: [
			{
				id: "n-1",
				kind: "story",
				title,
				identifier: "DATA-1",
				url: "https://plane.example.test/archimedes/projects/data/issues/item-1",
				status: "Todo",
				statusGroup: "unstarted",
				labels: [],
				assignee: null,
				effortDays: null,
				priority: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-02T00:00:00.000Z",
				criteria: [],
				quality: { ok: false, flags: ["no acceptance criteria"] },
				children: [],
			},
		],
		edges: [],
		labels: [],
		assignees: [],
		statuses: ["Todo"],
		counts: { epics: 0, stories: 1, criteria: 0, flagged: 1, edges: 0 },
	};
}

function graphWithEdge(): AtlasGraph {
	const value = graph();
	value.nodes.push({
		...value.nodes[0]!,
		id: "n-2",
		title: "Second cached title",
		identifier: "DATA-2",
		url: "https://plane.example.test/archimedes/projects/data/issues/item-2",
	});
	value.edges = [{ source: "n-1", target: "n-2", type: "blocks" }];
	value.counts = { epics: 0, stories: 2, criteria: 0, flagged: 2, edges: 1 };
	return value;
}

function cache(overrides: Partial<BoardCache> = {}): BoardCache {
	const cachedGraph = overrides.graph ?? graph();
	const flatten = (nodes: AtlasGraph["nodes"]): AtlasGraph["nodes"] =>
		nodes.flatMap((node) => [node, ...flatten(node.children)]);
	const items =
		overrides.items ??
		flatten(cachedGraph.nodes).map((node) => ({
			id: node.url?.split("/").filter(Boolean).at(-1) ?? `item-${node.id}`,
			identifier: node.identifier as string,
			title: node.title,
			updatedAt: node.updatedAt,
		}));
	return {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt: new Date(Date.parse(NOW) - 14 * 60_000).toISOString(),
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: overrides.itemCount ?? items.length,
		items,
		dependencyCoverage: { kind: "complete" },
		graph: cachedGraph,
		...overrides,
	};
}

function writeCache(value: BoardCache = cache()): void {
	mkdirSync(join(directory, ".planestories"), { recursive: true });
	writeFileSync(cachePath, serializeBoardCache(value));
}

function fakeLive(title = "Live title") {
	return makeFakeClient({
		projects: [PROJECT],
		workItems: {
			[PROJECT.id]: [
				{
					id: "item-1",
					sequence_id: 1,
					name: title,
					description_html: "<p>A live description long enough for the quality overlay.</p>",
					priority: "none",
					state: { name: "Todo", group: "unstarted" },
					assignees: [],
					labels: [],
					created_at: "2026-08-20T00:00:00Z",
					updated_at: "2026-08-21T00:00:00Z",
				},
			],
		},
		relations: { "item-1": {} },
	});
}

function runtime(
	fake: ReturnType<typeof fakeLive>,
	messages: { log: string[]; warn: string[] },
): GraphSourceRuntime {
	return {
		cachePath,
		now: () => new Date(NOW),
		log: (message) => messages.log.push(message),
		warn: (message) => messages.warn.push(message),
		connectTarget: async (config) => ({ config, client: fake.client }),
	};
}

async function resolveCached(
	fake: ReturnType<typeof fakeLive>,
	messages: { log: string[]; warn: string[] },
	cacheOptions: { refresh?: boolean; staleOk?: boolean; writeRequired?: boolean } = {},
) {
	return resolveGraph(
		{
			config: configPath,
			project: PROJECT.name,
			boardCache: cacheOptions,
		},
		runtime(fake, messages),
	);
}

describe("resolveGraph — board cache source", () => {
	test("a matching fresh cache is used with zero client calls and prints its age", async () => {
		writeCache();
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages);
		const resolved = source.acceptPartialGraph("cache fixture is complete");

		expect(resolved.nodes[0]?.title).toBe("Cached title");
		expect(source.requireCachedWorkItems("a bounded test read")).toEqual(cache().items);
		expect(source.provenance).toMatchObject({
			kind: "cache",
			project: PROJECT.name,
			fetchedAt: "2026-08-23T11:46:00.000Z",
			itemCount: 1,
		});
		expect(fake.calls).toEqual([]);
		expect(messages.log).toContain(
			"→ cached board state · Data Platform · 1 item · fetched 14m ago",
		);
		expect(messages.warn).toEqual([]);
	});

	test("a future fetchedAt is corrupt and falls back to a live read", async () => {
		mkdirSync(join(directory, ".planestories"), { recursive: true });
		writeFileSync(
			cachePath,
			`${JSON.stringify(cache({ fetchedAt: "2099-01-01T00:00:00.000Z" }), null, "\t")}\n`,
		);
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages);

		expect(source.provenance.kind).toBe("live");
		expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(true);
		expect(messages.warn.join("\n")).toMatch(/fetchedAt.*future/i);
		expect(messages.log.join("\n")).not.toContain("cached board state");
	});

	test("a required-cache read never falls through to a live whole-board fetch", async () => {
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		await expect(
			resolveGraph(
				{
					config: configPath,
					project: PROJECT.name,
					boardCache: { readRequired: true },
					dependencies: false,
				},
				runtime(fake, messages),
			),
		).rejects.toBeInstanceOf(RequiredBoardCacheError);
		expect(fake.calls).toEqual([]);

		mkdirSync(join(directory, ".planestories"), { recursive: true });
		writeFileSync(cachePath, "{ truncated");
		try {
			await resolveGraph(
				{
					config: configPath,
					project: PROJECT.name,
					boardCache: { readRequired: true },
					dependencies: false,
				},
				runtime(fake, messages),
			);
			throw new Error("expected required-cache refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(RequiredBoardCacheError);
			expect((error as Error).message).toContain("planestories board fetch");
		}
		expect(fake.calls).toEqual([]);
		expect(messages.warn.join("\n")).toContain("requires a refreshed matching cache");
		expect(messages.warn.join("\n")).not.toContain("Fetching fresh board state");
	});

	test("a matching stale cache refuses before any client call and names both ways forward", async () => {
		writeCache(
			cache({
				fetchedAt: new Date(Date.parse(NOW) - BOARD_CACHE_MAX_AGE_MS - 60_000).toISOString(),
			}),
		);
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		try {
			await resolveCached(fake, messages);
			throw new Error("expected stale cache refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(StaleBoardCacheError);
			expect((error as Error).message).toContain("--refresh");
			expect((error as Error).message).toContain("--stale-ok");
		}
		expect(fake.calls).toEqual([]);
		expect(messages.log.join("\n")).toContain("cached board state");
	});

	test("a required matching cache that is stale names board fetch and never goes live", async () => {
		writeCache(
			cache({
				fetchedAt: new Date(Date.parse(NOW) - BOARD_CACHE_MAX_AGE_MS - 60_000).toISOString(),
			}),
		);
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		try {
			await resolveGraph(
				{
					config: configPath,
					project: PROJECT.name,
					boardCache: { readRequired: true },
					dependencies: false,
				},
				runtime(fake, messages),
			);
			throw new Error("expected required-cache refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(RequiredBoardCacheError);
			expect((error as Error).message).toContain("planestories board fetch");
			expect((error as Error).message).not.toContain("--stale-ok");
		}
		expect(fake.calls).toEqual([]);
	});

	test("--stale-ok proceeds only with an explicit acknowledgement", async () => {
		writeCache(cache({ fetchedAt: "2026-08-23T09:00:00.000Z" }));
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages, { staleOk: true });

		expect(source.provenance.kind).toBe("cache");
		expect(fake.calls).toEqual([]);
		expect(messages.warn.join("\n")).toMatch(/stale-ok.*explicitly|explicitly.*stale-ok/);
	});

	test("--refresh bypasses the cache, fetches with the fake client, and replaces it", async () => {
		writeCache();
		const fake = fakeLive("Refreshed title");
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages, { refresh: true });
		const refreshed = parseBoardCache(readFileSync(cachePath, "utf8"));

		expect(source.provenance.kind).toBe("live");
		expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(true);
		expect(fake.calls.some((call) => call.method === "getRelations")).toBe(true);
		expect(refreshed.fetchedAt).toBe(NOW);
		expect(refreshed.graph.nodes[0]?.title).toBe("Refreshed title");
	});

	test("a cached --no-dependencies view strips edges and reports skipped coverage", async () => {
		writeCache(cache({ itemCount: 2, graph: graphWithEdge() }));
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveGraph(
			{
				config: configPath,
				project: PROJECT.name,
				boardCache: {},
				dependencies: false,
			},
			runtime(fake, messages),
		);
		const hierarchy = source.acceptPartialGraph("the operator explicitly skipped dependencies");

		expect(source.coverage).toEqual({ kind: "skipped" });
		expect(hierarchy.edges).toEqual([]);
		expect(hierarchy.counts.edges).toBe(0);
		expect(fake.calls).toEqual([]);
	});

	test("--refresh with --no-dependencies refuses instead of promising a cache it cannot write", async () => {
		writeCache();
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		expect(
			resolveGraph(
				{
					config: configPath,
					project: PROJECT.name,
					boardCache: { refresh: true },
					dependencies: false,
				},
				runtime(fake, messages),
			),
		).rejects.toThrow(/omit --no-dependencies.*omit --refresh/i);
		expect(fake.calls).toEqual([]);
	});

	for (const mismatch of ["host", "workspace", "project"] as const) {
		test(`a stale cache from a different ${mismatch} is ignored and fetched live`, async () => {
			const wrong = cache({ fetchedAt: "2020-01-01T00:00:00.000Z" });
			if (mismatch === "host") {
				wrong.instance = { ...wrong.instance, baseUrl: "https://other.example.test" };
			} else if (mismatch === "workspace") {
				wrong.instance = { ...wrong.instance, workspaceSlug: "other-workspace" };
			} else {
				wrong.project = {
					id: "other-project",
					identifier: "OTHER",
					name: "Other Board",
					selectedAs: "Other Board",
				};
				wrong.graph = graph("Wrong-board title", "Other Board");
			}
			writeCache(wrong);
			const fake = fakeLive("Correct live title");
			const messages = { log: [] as string[], warn: [] as string[] };

			const source = await resolveCached(fake, messages);

			expect(source.provenance.kind).toBe("live");
			expect(source.acceptPartialGraph("live fixture").nodes[0]?.title).toBe("Correct live title");
			expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(true);
		});
	}

	test("a project name/identifier collision cannot select another project's cache", async () => {
		const exactNameProject = { id: "project-a", identifier: "ALPHA", name: "DATA" };
		const collidingIdentifierProject = {
			id: "project-b",
			identifier: "DATA",
			name: "Data Platform",
		};
		writeCache(
			cache({
				project: { ...collidingIdentifierProject, selectedAs: collidingIdentifierProject.name },
				graph: graph("Wrong colliding cache", collidingIdentifierProject.name),
			}),
		);
		const fake = makeFakeClient({
			projects: [exactNameProject, collidingIdentifierProject],
			workItems: {
				[exactNameProject.id]: [
					{
						id: "item-a",
						sequence_id: 1,
						name: "Correct exact-name project",
						description_html: "<p>The project selected by Plane's normal precedence.</p>",
						priority: "none",
						state: { name: "Todo", group: "unstarted" },
						assignees: [],
						labels: [],
					},
				],
				[collidingIdentifierProject.id]: [],
			},
			relations: { "item-a": {} },
		});
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveGraph(
			{
				config: configPath,
				project: "DATA",
				boardCache: {},
			},
			{
				...runtime(fake, messages),
				connectTarget: async (config) => ({ config, client: fake.client }),
			},
		);

		expect(source.provenance).toMatchObject({ kind: "live", project: "DATA" });
		expect(source.acceptPartialGraph("live collision regression").nodes[0]?.title).toBe(
			"Correct exact-name project",
		);
		expect(fake.calls).toContainEqual({
			method: "listWorkItems",
			args: [exactNameProject.id, { expand: "state,assignees,labels" }],
		});
	});

	test("a corrupt cache warns and degrades to a real fresh fetch, never an empty graph", async () => {
		mkdirSync(join(directory, ".planestories"), { recursive: true });
		writeFileSync(cachePath, "{ this is truncated");
		const fake = fakeLive("Recovered live title");
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages);
		const resolved = source.acceptPartialGraph("live recovery remains useful");

		expect(source.provenance.kind).toBe("live");
		expect(resolved.nodes).toHaveLength(1);
		expect(resolved.nodes[0]?.title).toBe("Recovered live title");
		expect(messages.warn.join("\n")).toMatch(/corrupt|unreadable/i);
		expect(messages.warn.join("\n")).toMatch(/fresh|live/i);
	});

	test("a syntactically valid but invalid cache shape also warns and fetches live", async () => {
		mkdirSync(join(directory, ".planestories"), { recursive: true });
		writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, graph: {} }));
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages);

		expect(source.provenance.kind).toBe("live");
		expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(true);
		expect(messages.warn).toHaveLength(1);
	});

	test("an unreadable cache path warns and fetches live", async () => {
		mkdirSync(cachePath, { recursive: true });
		const fake = fakeLive("Live after unreadable cache");
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await resolveCached(fake, messages);

		expect(source.provenance.kind).toBe("live");
		expect(source.acceptPartialGraph("live recovery").nodes[0]?.title).toBe(
			"Live after unreadable cache",
		);
		expect(messages.warn.join("\n")).toMatch(/unreadable/i);
	});

	test("a partial refresh never replaces the last complete cache", async () => {
		writeCache();
		const before = readFileSync(cachePath, "utf8");
		const fake = fakeLive("Partial live title");
		fake.client.getRelations = async (projectId: string, workItemId: string) => {
			fake.calls.push({ method: "getRelations", args: [projectId, workItemId] });
			throw new Error("simulated relation read failure");
		};
		const messages = { log: [] as string[], warn: [] as string[] };

		// The source itself must enforce refresh publication even if a caller
		// accidentally omits the planner's reinforcing writeRequired assertion.
		expect(resolveCached(fake, messages, { refresh: true })).rejects.toThrow(
			/cache.*not.*written|not.*write.*cache/i,
		);
		expect(readFileSync(cachePath, "utf8")).toBe(before);
	});

	test("--from-snapshot keeps precedence and never inspects a corrupt cache", async () => {
		mkdirSync(cachePath, { recursive: true });
		const fake = fakeLive();
		const messages = { log: [] as string[], warn: [] as string[] };
		const snapshotPath = join(directory, "snapshot.json");
		const { serializeSnapshot } = await import("../../../src/replicate/snapshot.ts");
		const { sampleSnapshot } = await import("../replicate/fixtures.ts");
		writeFileSync(snapshotPath, serializeSnapshot(sampleSnapshot()));

		const source = await resolveGraph(
			{
				fromSnapshot: snapshotPath,
				boardCache: {},
				json: true,
			},
			runtime(fake, messages),
		);

		expect(source.provenance.kind).toBe("snapshot");
		expect(fake.calls).toEqual([]);
		expect(messages.warn).toEqual([]);
	});
});

describe("board cache persistence", () => {
	test("the board fetch action uses the fake client and publishes a complete cache", async () => {
		const fake = fakeLive("Fetched by board command");
		const messages = { log: [] as string[], warn: [] as string[] };

		const source = await fetchBoardToCache(
			{ config: configPath, project: PROJECT.name },
			runtime(fake, messages),
		);
		const written = parseBoardCache(readFileSync(cachePath, "utf8"));

		expect(source.provenance.kind).toBe("live");
		expect(written.graph.nodes[0]?.title).toBe("Fetched by board command");
		expect(written.dependencyCoverage).toEqual({ kind: "complete" });
		expect(fake.calls.some((call) => call.method === "listWorkItems")).toBe(true);
	});

	test("the cache inventory retains a legacy criterion child folded out of the graph", async () => {
		const fake = makeFakeClient({
			projects: [PROJECT],
			workItems: {
				[PROJECT.id]: [
					{
						id: "parent",
						sequence_id: 1,
						name: "Parent story",
						state: { name: "Todo", group: "unstarted" },
						updated_at: "2026-08-23T10:00:00Z",
					},
					{
						id: "criterion",
						sequence_id: 2,
						name: "Legacy criterion",
						parent: "parent",
						external_id: "parent::ac1",
						external_source: "planestories",
						state: { name: "Todo", group: "unstarted" },
						updated_at: "2026-08-23T10:30:00Z",
					},
				],
			},
			relations: { parent: {} },
		});
		const messages = { log: [] as string[], warn: [] as string[] };

		await fetchBoardToCache({ config: configPath, project: PROJECT.name }, runtime(fake, messages));
		const written = parseBoardCache(readFileSync(cachePath, "utf8"));

		expect(written.itemCount).toBe(2);
		expect(written.items.map((item) => item.id)).toEqual(["parent", "criterion"]);
		expect(written.items[1]).toMatchObject({
			identifier: "DATA-2",
			title: "Legacy criterion",
			updatedAt: "2026-08-23T10:30:00.000Z",
		});
		expect(written.graph.nodes).toHaveLength(1);
	});

	test("the default path is repository-root .planestories/board.json from a subdirectory", () => {
		const repo = join(directory, "repo");
		const subdir = join(repo, "src", "nested");
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/test\n");
		mkdirSync(subdir, { recursive: true });

		expect(defaultBoardCachePath(subdir)).toBe(join(repo, ".planestories", "board.json"));
	});

	test("atomic replacement preserves the previous cache if rename fails", async () => {
		writeCache();
		const before = readFileSync(cachePath, "utf8");
		const replacement = cache({ fetchedAt: NOW, graph: graph("Replacement") });

		await expect(
			writeBoardCacheAtomic(cachePath, replacement, {
				rename: async () => {
					throw new Error("simulated interrupted publish");
				},
			}),
		).rejects.toThrow("simulated interrupted publish");

		expect(readFileSync(cachePath, "utf8")).toBe(before);
		expect(
			readdirSync(join(directory, ".planestories")).filter((name) => name.includes(".tmp-")),
		).toEqual([]);
	});

	test("a complete cache round-trips, while partial coverage is rejected", () => {
		expect(parseBoardCache(serializeBoardCache(cache()))).toEqual(cache());
		const partial = { ...cache(), dependencyCoverage: { kind: "partial", failures: 1 } };
		expect(() => parseBoardCache(JSON.stringify(partial))).toThrow(/complete|coverage/i);
	});

	test("test fixture uses no accidental filesystem residue", () => {
		expect(existsSync(configPath)).toBe(true);
		expect((fakeLive().client as PlaneClient).baseUrl).toBeString();
	});
});

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

describe("cached read commands — real CLI cache wiring", () => {
	beforeEach(() => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "unused_because_the_cache_must_win",
				workspaceSlug: WORKSPACE,
				baseUrl: "http://127.0.0.1:1",
				dialect: "issues",
				defaultProject: PROJECT.name,
			}),
		);
		writeCache(
			cache({
				fetchedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
				instance: { baseUrl: "http://127.0.0.1:1", workspaceSlug: WORKSPACE },
			}),
		);
	});

	test("show reads the cache, keeps JSON stdout clean, and prints age on stderr", () => {
		const result = runCli(["show", "DATA-1", "--json"], directory);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toMatchObject({
			identifier: "DATA-1",
			title: "Cached title",
			provenance: { kind: "cache", fetchedAt: expect.any(String) },
		});
		expect(result.err).toContain("→ cached board state · Data Platform · 1 item · fetched 14m ago");
		expect(result.out).not.toContain("cached board state");
	});

	test("atlas reads the same cache and prints the same age line", () => {
		const output = join(directory, "atlas.json");
		const result = runCli(["atlas", "--project", PROJECT.name, "--json", "-o", output], directory);

		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
			project: PROJECT.name,
			source: "board",
		});
		expect(result.err).toContain("cached board state");
		expect(result.err).toContain("fetched 14m ago");
	});

	for (const command of ["ls", "count"]) {
		test(`${command} reads the cache, embeds provenance, and prints its age`, () => {
			const result = runCli([command, "--json"], directory);

			expect(result.code).toBe(0);
			expect(JSON.parse(result.out)).toMatchObject({
				count: 1,
				denominator: 1,
				provenance: { kind: "cache", fetchedAt: expect.any(String) },
			});
			expect(result.err).toContain(
				"→ cached board state · Data Platform · 1 item · fetched 14m ago",
			);
			expect(result.out).not.toContain("cached board state");
		});
	}

	test("graph queries read the complete cache and carry its relative age in the answer", () => {
		const result = runCli(["ready"], directory);

		expect(result.code).toBe(0);
		expect(result.out).toContain("Ready: 1 item(s)");
		expect(result.out).toContain("Source: Data Platform board");
		expect(result.out).toMatch(/cached 1[34]m ago/);
		expect(result.err).toContain("cached board state");
	});

	test("ls --blocked uses the cache's complete dependency graph", () => {
		writeCache(
			cache({
				fetchedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
				itemCount: 2,
				graph: graphWithEdge(),
				instance: { baseUrl: "http://127.0.0.1:1", workspaceSlug: WORKSPACE },
			}),
		);
		const result = runCli(["ls", "--blocked", "--json"], directory);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toMatchObject({
			count: 1,
			denominator: 2,
			items: [{ identifier: "DATA-2" }],
			provenance: { kind: "cache" },
		});
	});

	test("stale show refuses, while --stale-ok proceeds with an acknowledgement", () => {
		writeCache(
			cache({
				fetchedAt: new Date(Date.now() - 2 * BOARD_CACHE_MAX_AGE_MS).toISOString(),
				instance: { baseUrl: "http://127.0.0.1:1", workspaceSlug: WORKSPACE },
			}),
		);

		const refused = runCli(["show", "DATA-1"], directory);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("--refresh");
		expect(refused.err).toContain("--stale-ok");

		const accepted = runCli(["show", "DATA-1", "--stale-ok"], directory);
		expect(accepted.code).toBe(0);
		expect(accepted.err).toMatch(/stale-ok.*explicitly|explicitly.*stale-ok/);
	});

	test("board fetch is registered with the target-selection options", () => {
		const result = runCli(["board", "fetch", "--help"], directory);

		expect(result.code).toBe(0);
		expect(result.out).toContain(".planestories/board.json");
		expect(result.out).toContain("--context");
		expect(result.out).toContain("--project");
	});
});

/**
 * The clock-skew allowance on `fetchedAt`, pinned.
 *
 * A future `fetchedAt` used to clamp to age 0, making such a cache permanently
 * fresh and defeating the staleness limit, `StaleBoardCacheError` and
 * `--stale-ok` in one line. It is rejected now — but with ZERO tolerance a cache
 * written two seconds ago on a marginally fast clock is discarded as corrupt,
 * forcing a full 885-request refetch.
 *
 * Review's point, and it is the house rule: the existing far-future test would
 * still pass if the allowance were reverted to zero, so it does not pin the
 * allowance at all. This does.
 */
describe("board cache clock skew", () => {
	// Reuse the file's own builder rather than hand-rolling a fixture: an
	// incomplete one fails on a DIFFERENT validation and would have "passed" this
	// test for the wrong reason.
	const at = (msFromNow: number) =>
		serializeBoardCache(cache({ fetchedAt: new Date(Date.now() + msFromNow).toISOString() }));

	test("a cache seconds ahead of this clock is STILL USABLE", () => {
		// Writer and reader are different processes and may be on different clocks.
		for (const secondsAhead of [1, 2, 30, 90]) {
			expect(
				() => parseBoardCache(at(secondsAhead * 1000)),
				`${secondsAhead}s ahead`,
			).not.toThrow();
		}
	});

	test("a cache well beyond the allowance is refused as corrupt", () => {
		expect(() => parseBoardCache(at(10 * 60_000))).toThrow(/future/i);
	});
});
