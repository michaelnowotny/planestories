import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function baseData(extra?: Partial<FakeData>): FakeData {
	return {
		projects: [{ id: PROJECT, name: "Proj", identifier: "ENG" }],
		states: {
			[PROJECT]: [
				{ id: "done", name: "Done", group: "completed" },
				{ id: "backlog", name: "Backlog", group: "backlog" },
			],
		},
		labels: { [PROJECT]: [] },
		members: {},
		workItems: { [PROJECT]: [] },
		...extra,
	};
}

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "criteria-"));
});
afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("criteria sync — over-long criterion (finance bug report: 255-char title cap)", () => {
	// A 300-char "close condition" acceptance criterion (the finance epics' house convention).
	const LONG = `A thorough close condition that ${"x".repeat(300)}`;

	test("truncates a >255-char criterion name and keeps the full text in its description (no 400)", async () => {
		const filePath = join(tmpDir, "long.md");
		writeFileSync(
			filePath,
			[
				"## An epic with a long close condition",
				"",
				"```yaml",
				"kind: epic",
				"status: Backlog",
				"```",
				"",
				"Narrative.",
				"",
				"### Acceptance Criteria",
				`- [ ] ${LONG}`,
			].join("\n"),
		);
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config, syncCriteria: true });

		// The whole import succeeds — no "title cannot exceed 255" failure.
		expect(summary.created).toBe(1);
		expect(summary.failed).toBe(0);

		// Parent + one criterion child were created.
		expect(createdItems).toHaveLength(2);
		const child = createdItems.find((c) => c.body.parent !== undefined);
		expect(child).toBeDefined();
		// The child's NAME fits Plane's 255-char cap...
		expect((child?.body.name as string).length).toBeLessThanOrEqual(255);
		// ...and the FULL criterion text is preserved in its description.
		expect(String(child?.body.description_html)).toContain(LONG);

		// Parent linked back into the file (no orphaning).
		expect(readFileSync(filePath, "utf-8")).toContain("plane_id: ");
	});
});

describe("follow-up failure does not orphan the created parent (Fix B)", () => {
	const storyFile = (path: string) =>
		writeFileSync(
			path,
			[
				"## A story whose criteria sync fails",
				"",
				"```yaml",
				"status: Backlog",
				"```",
				"",
				"Body.",
				"",
				"### Acceptance Criteria",
				"- [ ] does a thing",
			].join("\n"),
		);

	test("parent is created + linked with a warning (hash withheld); a re-run finishes the criteria", async () => {
		const filePath = join(tmpDir, "recover.md");
		storyFile(filePath);

		// First import: child creates fail — the parent must still be created + linked.
		const first = makeFakeClient(baseData({ failChildCreates: true }));
		const summary = await importStories(first.client, {
			files: [filePath],
			config,
			syncCriteria: true,
		});

		expect(summary.created).toBe(1); // parent created, NOT failed
		expect(summary.failed).toBe(0);
		expect(summary.results[0]?.note).toContain("criteria sync did not finish");

		// plane_id written back so a re-run updates; plane_hash WITHHELD so it isn't skipped.
		const linked = readFileSync(filePath, "utf-8");
		expect(linked).toContain("plane_id: ");
		expect(linked).not.toContain("plane_hash:");

		// Re-run with child creates working: parent updates, criteria finish, no failure, no re-create.
		const second = makeFakeClient(baseData());
		const summary2 = await importStories(second.client, {
			files: [filePath],
			config,
			syncCriteria: true,
		});

		expect(summary2.failed).toBe(0);
		expect(summary2.created).toBe(0); // not re-created
		expect(summary2.updated).toBe(1);
		// The criterion child was created this time (follow-up completed).
		expect(second.createdItems.some((c) => c.body.parent !== undefined)).toBe(true);
		// Now warm: plane_hash written on the successful run.
		expect(readFileSync(filePath, "utf-8")).toContain("plane_hash:");
	});
});
