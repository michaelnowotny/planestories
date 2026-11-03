import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import {
	BOARD_CACHE_SCHEMA_VERSION,
	type BoardCache,
	type BoardCacheCommentInventory,
	serializeBoardCache,
} from "../../../src/cli/board_cache.ts";
import { computeSnapshotDigest, serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import { sampleSnapshot } from "../replicate/fixtures.ts";

const BASE_URL = "http://127.0.0.1:1";
const WORKSPACE = "archimedes";
const PROJECT = {
	id: "11111111-1111-4111-8111-111111111111",
	identifier: "DATA",
	name: "Data Platform",
};
const FETCHED = new Date(Date.now() - 14 * 60_000).toISOString();
const BODY = "UNIQUE COMMENT BODY";

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

function storyNode(): AtlasNode {
	return {
		id: "n-7",
		kind: "story",
		title: "Commented story",
		identifier: "DATA-7",
		url: `${BASE_URL}/${WORKSPACE}/projects/${PROJECT.id}/issues/story-7`,
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

function boardCache(inventory: "absent" | BoardCacheCommentInventory | "empty"): BoardCache {
	const graph: AtlasGraph = {
		project: PROJECT.name,
		source: "board",
		nodes: [storyNode()],
		edges: [],
		labels: [],
		assignees: [],
		statuses: ["Todo"],
		counts: { epics: 0, stories: 1, criteria: 0, flagged: 0, edges: 0 },
	};
	const value: BoardCache = {
		schemaVersion: BOARD_CACHE_SCHEMA_VERSION,
		fetchedAt: FETCHED,
		instance: { baseUrl: BASE_URL, workspaceSlug: WORKSPACE },
		project: { ...PROJECT, selectedAs: PROJECT.name },
		itemCount: 1,
		items: [
			{
				id: "story-7",
				identifier: "DATA-7",
				title: "Commented story",
				updatedAt: "2026-08-02T00:00:00.000Z",
			},
		],
		dependencyCoverage: { kind: "complete" },
		graph,
		records: [
			{
				id: "story-7",
				sequenceId: 7,
				name: "Commented story",
				descriptionHtml: "<p>Packet body text.</p>",
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
		],
		relations: {},
	};
	if (inventory === "not-requested") value.commentInventory = "not-requested";
	if (inventory === "empty") {
		value.commentInventory = "captured";
		value.comments = {};
	}
	if (inventory === "captured") {
		value.commentInventory = "captured";
		value.comments = {
			"story-7": [
				{
					id: "comment-7",
					commentHtml: `<p>${BODY}</p>`,
					createdAt: "2026-08-03T00:00:00.000Z",
					createdBy: null,
				},
			],
		};
	}
	return value;
}

function writeWorkspace(value: BoardCache | null): string {
	const directory = mkdtempSync(join(tmpdir(), "planestories-comments-"));
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

function writeSnapshot(): { directory: string; snapshotPath: string } {
	const directory = mkdtempSync(join(tmpdir(), "planestories-comments-snap-"));
	mkdirSync(join(directory, ".git"), { recursive: true });
	writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/test\n");
	const snapshot = sampleSnapshot();
	snapshot.comments = {
		"source-3": [
			{
				id: "comment-unique",
				commentHtml: `<p>${BODY}</p>`,
				createdAt: "2024-01-02T00:00:00Z",
				createdBy: null,
			},
		],
	};
	snapshot.digest = computeSnapshotDigest(snapshot);
	const snapshotPath = join(directory, "board.snapshot.json");
	writeFileSync(snapshotPath, serializeSnapshot(snapshot));
	return { directory, snapshotPath };
}

test("show and packet hide captured comments unless --with-comments", () => {
	const directory = writeWorkspace(boardCache("captured"));
	try {
		const hidden = runCli(["show", "DATA-7"], directory);
		expect(hidden.code).toBe(0);
		expect(hidden.out).toContain("1 comment not shown");
		expect(hidden.out).not.toContain(BODY);

		const shown = runCli(["show", "DATA-7", "--with-comments"], directory);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain(BODY);
		expect(shown.out).not.toContain("not shown");

		const packetHidden = runCli(["packet", "DATA-7"], directory);
		expect(packetHidden.code).toBe(0);
		expect(packetHidden.out).toContain("Packet body text.");
		expect(packetHidden.out).toContain("1 comment not shown");
		expect(packetHidden.out).not.toContain(BODY);

		const packetShown = runCli(["packet", "DATA-7", "--with-comments"], directory);
		expect(packetShown.code).toBe(0);
		expect(packetShown.out).toContain(BODY);
		expect(packetShown.out).not.toContain("not shown");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a cache that did not capture comments never prints a zero count", () => {
	const directory = writeWorkspace(boardCache("not-requested"));
	try {
		for (const args of [
			["show", "DATA-7"],
			["packet", "DATA-7"],
		]) {
			const hidden = runCli(args, directory);
			expect(hidden.code, args.join(" ")).toBe(0);
			expect(hidden.out, args.join(" ")).toContain("comments not shown (not fetched)");
			expect(hidden.out, args.join(" ")).not.toContain("0 comments");
			expect(hidden.err, args.join(" ")).not.toContain("ECONNREFUSED");

			const asked = runCli([...args, "--with-comments"], directory);
			expect(asked.code, args.join(" ")).not.toBe(0);
			expect(asked.err, args.join(" ")).toContain("board fetch --with-comments");
			expect(asked.out, args.join(" ")).not.toContain(BODY);
			expect(asked.err, args.join(" ")).not.toContain("ECONNREFUSED");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a captured sweep with no comments reports zero, which is different from not fetched", () => {
	const directory = writeWorkspace(boardCache("empty"));
	try {
		const shown = runCli(["show", "DATA-7"], directory);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("0 comments not shown");
		expect(shown.out).not.toContain("not fetched");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("show --json stays one document and does not embed comment text unless asked", () => {
	const { directory, snapshotPath } = writeSnapshot();
	try {
		const hidden = runCli(["show", "SRC-3", "--from-snapshot", snapshotPath, "--json"], directory);
		expect(hidden.code).toBe(0);
		const payload = JSON.parse(hidden.out);
		expect(payload.commentsNote).toBe("1 comment not shown");
		expect(hidden.out).not.toContain(BODY);
		expect(payload.comments).toBeUndefined();

		const shown = runCli(
			["show", "SRC-3", "--from-snapshot", snapshotPath, "--json", "--with-comments"],
			directory,
		);
		expect(shown.code).toBe(0);
		const withBodies = JSON.parse(shown.out);
		expect(withBodies.comments[0].text).toContain(BODY);
		expect(shown.out).not.toContain("not shown");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("show and packet read snapshot comments without a live call", () => {
	const { directory, snapshotPath } = writeSnapshot();
	try {
		const hidden = runCli(["show", "SRC-3", "--from-snapshot", snapshotPath], directory);
		expect(hidden.code).toBe(0);
		expect(hidden.out).toContain("1 comment not shown");
		expect(hidden.out).not.toContain(BODY);
		expect(hidden.err).toContain("NOT live");

		const shown = runCli(
			["show", "SRC-3", "--from-snapshot", snapshotPath, "--with-comments"],
			directory,
		);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain(BODY);
		expect(shown.out).not.toContain("not shown");

		const packet = runCli(
			["packet", "SRC-3", "--from-snapshot", snapshotPath, "-p", "Source", "--with-comments"],
			directory,
		);
		expect(packet.code).toBe(0);
		expect(packet.out).toContain(BODY);
		expect(packet.err).toContain("NOT live");
		expect(packet.err).not.toContain("ECONNREFUSED");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("export prints the comment count on stderr and leaves the story file unchanged", () => {
	const bare = writeWorkspace(null);
	try {
		const refused = runCli(["export", "--with-comments"], bare);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("board fetch --with-comments");
		expect(existsSync(join(bare, "exports"))).toBe(false);
	} finally {
		rmSync(bare, { recursive: true, force: true });
	}

	const { directory, snapshotPath } = writeSnapshot();
	try {
		const hidden = runCli(
			["export", "--from-snapshot", snapshotPath, "-p", "Source", "-o", "exports/out.md"],
			directory,
		);
		expect(hidden.code).toBe(0);
		expect(hidden.err).toContain("1 comment not shown");
		expect(hidden.out).not.toContain(BODY);
		const file = readFileSync(join(directory, "exports", "out.md"), "utf8");
		expect(file).not.toContain(BODY);
		expect(file).toContain("Description 3");

		const shown = runCli(
			[
				"export",
				"--from-snapshot",
				snapshotPath,
				"-p",
				"Source",
				"-o",
				"exports/out.md",
				"--with-comments",
			],
			directory,
		);
		expect(shown.code).toBe(0);
		expect(shown.err).toContain(BODY);
		expect(shown.err).not.toContain("not shown");
		expect(readFileSync(join(directory, "exports", "out.md"), "utf8")).not.toContain(BODY);
		expect(shown.out).not.toContain(BODY);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
