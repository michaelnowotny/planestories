import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../../src/errors.ts";
import { deleteStories } from "../../../src/sync/deleter.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
};

function baseData(extra: Partial<FakeData> = {}): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		...extra,
	};
}

const fileWithIds = `---
project: "Q1 Release"
---

## Story one

\`\`\`yaml
plane_id: wi-aaa
plane_identifier: ENG-1
plane_url: https://app.plane.so/ws/projects/p/issues/wi-aaa
\`\`\`

Body one.
`;

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "deleter-test-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("deleteStories — safety", () => {
	test("refuses to run without files or --external-source", async () => {
		const { client } = makeFakeClient(baseData());
		expect(deleteStories(client, { config })).rejects.toThrow(ConfigError);
	});

	test("dry-run plans targets but deletes nothing", async () => {
		const file = join(tmpDir, "s.md");
		writeFileSync(file, fileWithIds);
		const { client, deletedItems } = makeFakeClient(baseData());

		const summary = await deleteStories(client, { config, files: [file], dryRun: true });

		expect(summary.planned).toBe(1);
		expect(summary.dryRun).toBe(true);
		expect(deletedItems).toHaveLength(0);
		expect(readFileSync(file, "utf-8")).toContain("plane_id: wi-aaa"); // unchanged
	});

	test("unconfirmed run (no --yes) deletes nothing", async () => {
		const file = join(tmpDir, "s.md");
		writeFileSync(file, fileWithIds);
		const { client, deletedItems } = makeFakeClient(baseData());

		const summary = await deleteStories(client, { config, files: [file], confirmed: false });

		expect(summary.planned).toBe(1);
		expect(deletedItems).toHaveLength(0);
	});
});

describe("deleteStories — file mode", () => {
	test("deletes by plane_id and clears plane_* out of the file", async () => {
		const file = join(tmpDir, "s.md");
		writeFileSync(file, fileWithIds);
		const { client, deletedItems } = makeFakeClient(baseData());

		const summary = await deleteStories(client, { config, files: [file], confirmed: true });

		expect(summary.deleted).toBe(1);
		expect(deletedItems).toEqual([{ projectId: PROJECT_UUID, workItemId: "wi-aaa" }]);

		const after = readFileSync(file, "utf-8");
		expect(after).toContain("plane_id:");
		expect(after).not.toContain("wi-aaa"); // value cleared
		expect(after).toContain("Body one."); // rest preserved
	});

	test("--no-write-back leaves the file untouched", async () => {
		const file = join(tmpDir, "s.md");
		writeFileSync(file, fileWithIds);
		const { client } = makeFakeClient(baseData());

		await deleteStories(client, { config, files: [file], confirmed: true, noWriteBack: true });

		expect(readFileSync(file, "utf-8")).toContain("plane_id: wi-aaa");
	});

	test("archive mode applies the archive label and does NOT delete or clear the file", async () => {
		const file = join(tmpDir, "s.md");
		writeFileSync(file, fileWithIds);
		const { client, deletedItems, updatedItems } = makeFakeClient(
			baseData({
				labels: { [PROJECT_UUID]: [{ id: "lbl-archived", name: "archived" }] },
				workItems: { [PROJECT_UUID]: [{ id: "wi-aaa", sequence_id: 1, name: "one", labels: [] }] },
			}),
		);

		const summary = await deleteStories(client, {
			config,
			files: [file],
			confirmed: true,
			archive: true,
		});

		expect(summary.archived).toBe(1);
		expect(deletedItems).toHaveLength(0);
		// The archive label is merged onto the item's labels.
		expect(updatedItems).toHaveLength(1);
		expect(updatedItems[0]!.body.labels).toEqual(["lbl-archived"]);
		// Archived items still exist, so the file's plane_* must be preserved.
		expect(readFileSync(file, "utf-8")).toContain("plane_id: wi-aaa");
	});
});

describe("deleteStories — external_source mode", () => {
	test("deletes only items stamped with the external_source", async () => {
		const { client, deletedItems } = makeFakeClient(
			baseData({
				workItems: {
					[PROJECT_UUID]: [
						{ id: "wi-1", sequence_id: 1, name: "ours", external_source: "planestories" },
						{ id: "wi-2", sequence_id: 2, name: "theirs", external_source: null },
						{ id: "wi-3", sequence_id: 3, name: "ours2", external_source: "planestories" },
					],
				},
			}),
		);

		const summary = await deleteStories(client, {
			config,
			externalSource: "planestories",
			project: "Q1 Release",
			confirmed: true,
		});

		expect(summary.deleted).toBe(2);
		expect(deletedItems.map((d) => d.workItemId).sort()).toEqual(["wi-1", "wi-3"]);
	});

	test("requires a project for external_source mode", async () => {
		const { client } = makeFakeClient(baseData());
		expect(
			deleteStories(client, {
				config: { ...config, defaultProject: null },
				externalSource: "planestories",
				confirmed: true,
			}),
		).rejects.toThrow(ConfigError);
	});
});
