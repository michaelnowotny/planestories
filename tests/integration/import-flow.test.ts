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
