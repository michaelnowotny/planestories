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
		// Body / acceptance criteria preserved
		expect(updated).toContain("### Acceptance Criteria");
		expect(updated).toContain("- [ ] User can log in");
	});

	test("re-importing after write-back updates instead of duplicating", async () => {
		const filePath = join(tmpDir, "stories.md");
		writeFileSync(filePath, markdown);

		// First import creates + writes back.
		const first = makeFakeClient(baseData());
		await importStories(first.client, { files: [filePath], config });

		// Second import: the file now carries plane_id, so it takes the update path.
		const second = makeFakeClient(baseData());
		const summary = await importStories(second.client, { files: [filePath], config });

		expect(summary.created).toBe(0);
		expect(summary.updated).toBe(1);
		expect(second.createdItems).toHaveLength(0);
		expect(second.updatedItems).toHaveLength(1);
	});
});
