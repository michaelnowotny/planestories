import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportStories } from "../../src/sync/exporter.ts";
import { importStories } from "../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const TITLE = "As a user, I want to log in";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function baseData(workItems: Array<Record<string, unknown>>): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		states: { [PROJECT_UUID]: [{ id: "s1", name: "Backlog", group: "backlog" }] },
		labels: { [PROJECT_UUID]: [{ id: "l1", name: "Feature" }] },
		members: {},
		workItems: { [PROJECT_UUID]: workItems },
	};
}

const newStory = `---
project: "Q1 Release"
---

## ${TITLE}

\`\`\`yaml
status: Backlog
\`\`\`

Login description.
`;

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "dup-adopt-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("duplicate guard (P0-3)", () => {
	// A same-title item created by someone else (no matching external_id) already exists.
	const foreignDup = () =>
		baseData([{ id: "wi-dup", sequence_id: 7, name: TITLE, state: { name: "Backlog" } }]);

	test("default: skips a title-duplicate with a warning, no create", async () => {
		const filePath = join(tmpDir, "s.md");
		writeFileSync(filePath, newStory);
		const { client, createdItems } = makeFakeClient(foreignDup());

		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.created).toBe(0);
		expect(summary.skipped).toBe(1);
		expect(createdItems).toHaveLength(0);
		expect(summary.results[0]?.note).toContain("duplicate of ENG-7");
	});

	test("--adopt-duplicates: links a single exact match instead of creating", async () => {
		const filePath = join(tmpDir, "s.md");
		writeFileSync(filePath, newStory);
		const { client, createdItems, updatedItems } = makeFakeClient(foreignDup());

		const summary = await importStories(client, {
			files: [filePath],
			config,
			adoptDuplicates: true,
		});

		expect(summary.created).toBe(0);
		expect(summary.updated).toBe(1);
		expect(createdItems).toHaveLength(0);
		expect(updatedItems.some((u) => u.workItemId === "wi-dup")).toBe(true);
		// The adopted item's plane_id is written back into the file.
		expect(readFileSync(filePath, "utf-8")).toContain("plane_id: wi-dup");
	});

	test("--adopt-duplicates with multiple matches is a hard error", async () => {
		const filePath = join(tmpDir, "s.md");
		writeFileSync(filePath, newStory);
		const { client, createdItems, updatedItems } = makeFakeClient(
			baseData([
				{ id: "wi-a", sequence_id: 7, name: TITLE, state: { name: "Backlog" } },
				{ id: "wi-b", sequence_id: 8, name: TITLE, state: { name: "Backlog" } },
			]),
		);

		const summary = await importStories(client, {
			files: [filePath],
			config,
			adoptDuplicates: true,
		});

		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.error).toContain('share the title "As a user, I want to log in"');
		expect(createdItems).toHaveLength(0);
		expect(updatedItems).toHaveLength(0);
	});

	test("--force-create: creates anyway, bypassing the guard", async () => {
		const filePath = join(tmpDir, "s.md");
		writeFileSync(filePath, newStory);
		const { client, createdItems } = makeFakeClient(foreignDup());

		const summary = await importStories(client, { files: [filePath], config, forceCreate: true });

		expect(summary.created).toBe(1);
		expect(createdItems).toHaveLength(1);
	});
});

describe("hashless-but-linked adopt (P0-1 warm start for legacy files)", () => {
	// Board fixture rich enough to export a faithful story back.
	const boardData = () =>
		baseData([
			{
				id: "wi-1",
				sequence_id: 8,
				name: "Log in",
				description_html: "<p>User can log in.</p>",
				priority: "high",
				point: 3,
				state: { id: "s1", name: "Backlog", group: "backlog" },
				assignees: [{ id: "u1", email: "jane@co.com", display_name: "jane" }],
				labels: [{ id: "l1", name: "Feature" }],
			},
		]);

	/** Export the board, then strip plane_hash to simulate a pre-slice-2 linked file. */
	function legacyLinkedFile(path: string, edit?: (body: string) => string): Promise<void> {
		return exportStories(makeFakeClient(boardData()).client, {
			config,
			filters: {},
			outputPath: path,
		}).then(() => {
			let content = readFileSync(path, "utf-8")
				.split("\n")
				.filter((l) => !l.startsWith("plane_hash:"))
				.join("\n");
			if (edit) content = edit(content);
			writeFileSync(path, content);
		});
	}

	test("matches the board -> unchanged, zero writes, adopts the hash", async () => {
		const filePath = join(tmpDir, "legacy.md");
		await legacyLinkedFile(filePath);
		expect(readFileSync(filePath, "utf-8")).not.toContain("plane_hash:");

		const { client, createdItems, updatedItems } = makeFakeClient(boardData());
		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.unchanged).toBe(1);
		expect(summary.updated).toBe(0);
		expect(createdItems).toHaveLength(0);
		expect(updatedItems).toHaveLength(0);
		// The hash is now written back, so the next run is warm via the fast path.
		expect(readFileSync(filePath, "utf-8")).toContain("plane_hash:");
	});

	test("differs from the board -> updates (does not blind-skip)", async () => {
		const filePath = join(tmpDir, "legacy2.md");
		await legacyLinkedFile(filePath, (body) =>
			body.replace("User can log in.", "User can log in via SSO."),
		);

		const { client, updatedItems } = makeFakeClient(boardData());
		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.unchanged).toBe(0);
		expect(summary.updated).toBe(1);
		expect(updatedItems.some((u) => u.workItemId === "wi-1")).toBe(true);
	});
});
