import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStories } from "../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT = "proj-1";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Proj",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function baseData(workItems: Array<Record<string, unknown>> = []): FakeData {
	return {
		projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
		states: { [PROJECT]: [{ id: "s-done", name: "Done", group: "completed" }] },
		labels: { [PROJECT]: [] },
		members: {},
		workItems: { [PROJECT]: workItems },
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "slice7-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("cross-file parent (7a)", () => {
	const epicBoard = () => baseData([{ id: "epic-uuid", sequence_id: 5, name: "The Epic" }]);

	test("resolves `parent: ENG-N` to the parent UUID on create", async () => {
		const filePath = join(tmpDir, "child.md");
		writeFileSync(
			filePath,
			["## Child story", "", "```yaml", "parent: ENG-5", "```", "", "Body."].join("\n"),
		);
		const { client, createdItems } = makeFakeClient(epicBoard());

		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.created).toBe(1);
		expect(createdItems[0]?.body.parent).toBe("epic-uuid");
	});

	test("fails when the parent identifier is unknown", async () => {
		const filePath = join(tmpDir, "child.md");
		writeFileSync(
			filePath,
			["## Child story", "", "```yaml", "parent: ENG-99", "```", "", "Body."].join("\n"),
		);
		const { client, createdItems } = makeFakeClient(epicBoard());

		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.error).toContain('parent "ENG-99" not found');
		expect(createdItems).toHaveLength(0);
	});
});

describe("evidence comments (7c)", () => {
	// A linked story whose status changes; --status-only posts the note once.
	const linkedFile = (path: string, status: string) =>
		writeFileSync(
			path,
			[
				"## A linked story",
				"",
				"```yaml",
				"plane_id: wi-1",
				`status: ${status}`,
				'comment: "Closed after review sign-off"',
				"```",
				"",
				"Body.",
			].join("\n"),
		);

	test("posts a comment once and is idempotent across re-runs", async () => {
		const filePath = join(tmpDir, "evid.md");
		linkedFile(filePath, "Done");
		const { client, createdComments } = makeFakeClient(
			baseData([{ id: "wi-1", sequence_id: 1, name: "A linked story" }]),
		);

		await importStories(client, { files: [filePath], config, statusOnly: true });
		await importStories(client, { files: [filePath], config, statusOnly: true });

		// The evidence comment was posted exactly once (marker-deduped).
		expect(createdComments).toHaveLength(1);
		expect(createdComments[0]?.workItemId).toBe("wi-1");
		expect(String(createdComments[0]?.body.comment_html)).toContain("Closed after review sign-off");
	});
});

describe("strict structural guard (7b)", () => {
	const designDocFile = (path: string) =>
		writeFileSync(
			path,
			[
				"## A real story",
				"",
				"```yaml",
				"status: Done",
				"```",
				"",
				"Body.",
				"",
				"## A design-doc heading",
				"",
				"Just prose. No yaml block, no acceptance criteria.",
				"",
			].join("\n"),
		);

	test("--strict refuses a design-doc heading but imports the real story", async () => {
		const filePath = join(tmpDir, "mixed.md");
		designDocFile(filePath);
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config, strict: true });

		expect(summary.created).toBe(1);
		expect(summary.failed).toBe(1);
		expect(createdItems).toHaveLength(1);
		const failed = summary.results.find((r) => r.action === "failed");
		expect(failed?.story.title).toBe("A design-doc heading");
		expect(failed?.error).toContain("--strict");
	});

	test("default (non-strict) imports it but records a structure warning", async () => {
		const filePath = join(tmpDir, "mixed.md");
		designDocFile(filePath);
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.created).toBe(2);
		expect(createdItems).toHaveLength(2);
		expect(summary.structureWarnings.some((w) => w.includes("A design-doc heading"))).toBe(true);
	});
});
