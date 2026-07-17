import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStories } from "../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../src/types.ts";
import { type FakeData, makeFakeClient } from "../helpers/fake-plane-client.ts";

const PROJECT_UUID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const config: ResolvedConfig = {
	apiKey: "test-api-key",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Q1 Release",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function baseData(extra: Partial<FakeData> = {}): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Q1 Release", identifier: "ENG" }],
		labels: { [PROJECT_UUID]: [{ id: "lbl-feature", name: "Feature" }] },
		states: { [PROJECT_UUID]: [{ id: "state-backlog", name: "Backlog" }] },
		members: {},
		...extra,
	};
}

const markdown = `---
project: "Q1 Release"
---

## As a user, I want to log in

\`\`\`yaml
priority: high
labels: [Feature]
status: Backlog
\`\`\`

Login description.

### Acceptance Criteria

- [ ] User can log in
`;

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "import-flow-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("import flow (end to end)", () => {
	test("creates a work item and writes plane ids back into the file", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);
		const { client, createdItems } = makeFakeClient(baseData());

		const summary = await importStories(client, { files: [filePath], config });

		expect(summary.created).toBe(1);
		expect(createdItems).toHaveLength(1);

		const updated = readFileSync(filePath, "utf-8");
		expect(updated).toContain("plane_id: wi-101");
		expect(updated).toContain("plane_identifier: ENG-101");
		// Content hash is written back for skip-unchanged (P0-1).
		expect(updated).toContain("plane_hash: ");
		// Body / acceptance criteria preserved
		expect(updated).toContain("### Acceptance Criteria");
		expect(updated).toContain("- [ ] User can log in");
	});

	test("re-importing unchanged content is skipped as unchanged (zero writes)", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		// First import creates + writes back plane_id and plane_hash.
		const first = makeFakeClient(baseData());
		await importStories(first.client, { files: [filePath], config });

		// Second import: content unchanged, so the stored hash matches -> no API writes.
		const second = makeFakeClient(baseData());
		const summary = await importStories(second.client, { files: [filePath], config });

		expect(summary.created).toBe(0);
		expect(summary.updated).toBe(0);
		expect(summary.unchanged).toBe(1);
		expect(second.createdItems).toHaveLength(0);
		expect(second.updatedItems).toHaveLength(0);
	});

	test("changing content re-triggers an update (hash differs)", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		const first = makeFakeClient(baseData());
		await importStories(first.client, { files: [filePath], config });

		// Edit the narrative; the plane_* metadata block is preserved.
		const edited = readFileSync(filePath, "utf-8").replace(
			"Login description.",
			"Login description, now with SSO.",
		);
		writeFileSync(filePath, edited);

		const second = makeFakeClient(baseData());
		const summary = await importStories(second.client, { files: [filePath], config });

		expect(summary.created).toBe(0);
		expect(summary.updated).toBe(1);
		expect(summary.unchanged).toBe(0);
		expect(second.updatedItems).toHaveLength(1);
	});

	test("--force re-imports even when content is unchanged", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		const first = makeFakeClient(baseData());
		await importStories(first.client, { files: [filePath], config });

		const second = makeFakeClient(baseData());
		const summary = await importStories(second.client, {
			files: [filePath],
			config,
			force: true,
		});

		expect(summary.unchanged).toBe(0);
		expect(summary.updated).toBe(1);
		expect(second.updatedItems).toHaveLength(1);
	});
});

describe("import flow --status-only", () => {
	const withDone = () =>
		baseData({
			states: {
				[PROJECT_UUID]: [
					{ id: "state-backlog", name: "Backlog" },
					{ id: "state-done", name: "Done" },
				],
			},
		});

	test("patches only the state of a linked item (no title/body clobber, no hash rewrite)", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		// Full import links the story and writes plane_id + plane_hash.
		const first = makeFakeClient(withDone());
		await importStories(first.client, { files: [filePath], config });
		const linked = readFileSync(filePath, "utf-8");
		const hashLine = linked.split("\n").find((l) => l.startsWith("plane_hash:"));
		expect(hashLine).toBeDefined();

		// Flip the status; run status-only.
		writeFileSync(filePath, linked.replace("status: Backlog", "status: Done"));
		const second = makeFakeClient(withDone());
		const summary = await importStories(second.client, {
			files: [filePath],
			config,
			statusOnly: true,
		});

		expect(summary.updated).toBe(1);
		expect(second.updatedItems).toHaveLength(1);
		// ONLY the state is sent — name/description are not re-sent.
		expect(second.updatedItems[0]?.body).toEqual({ state: "state-done" });

		// status-only does not rewrite plane_hash (it did not sync the full payload).
		const after = readFileSync(filePath, "utf-8");
		expect(after.split("\n").find((l) => l.startsWith("plane_hash:"))).toBe(hashLine);
	});

	test("skips an unlinked story with a warning (no writes)", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown); // no plane_id yet
		const { client, createdItems, updatedItems } = makeFakeClient(withDone());

		const summary = await importStories(client, { files: [filePath], config, statusOnly: true });

		expect(summary.updated).toBe(0);
		expect(summary.skipped).toBe(1);
		expect(createdItems).toHaveLength(0);
		expect(updatedItems).toHaveLength(0);
		const skipped = summary.results.find((r) => r.action === "skipped");
		expect(skipped?.note).toContain("no plane_id");
	});

	test("makes zero writes when the file is fully unchanged", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		const first = makeFakeClient(withDone());
		await importStories(first.client, { files: [filePath], config });

		// Nothing edited: the content hash still matches, so it short-circuits.
		const second = makeFakeClient(withDone());
		const summary = await importStories(second.client, {
			files: [filePath],
			config,
			statusOnly: true,
		});

		expect(summary.updated).toBe(0);
		expect(summary.unchanged).toBe(1);
		expect(second.updatedItems).toHaveLength(0);
	});
});
