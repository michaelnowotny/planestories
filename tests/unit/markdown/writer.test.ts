import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBackIds } from "../../../src/markdown/writer.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures");

function readFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

const ENG42 = {
	planeId: "aaaa1111-1111-4111-8111-111111111111",
	planeIdentifier: "ENG-42",
	planeUrl: "https://app.plane.so/ws/projects/p/issues/aaaa1111-1111-4111-8111-111111111111",
};

const ENG43 = {
	planeId: "bbbb3333-3333-4333-8333-333333333333",
	planeIdentifier: "ENG-43",
	planeUrl: "https://app.plane.so/ws/projects/p/issues/bbbb3333-3333-4333-8333-333333333333",
};

describe("writeBackIds", () => {
	test("updates plane ids in correct story's YAML block", () => {
		const content = readFixture("single-story.md");
		const updates = [
			{ title: "As a user, I want to log in so that I can access my account", ...ENG42 },
		];

		const result = writeBackIds("single-story.md", content, updates);

		expect(result).toContain(`plane_id: ${ENG42.planeId}`);
		expect(result).toContain(`plane_identifier: ${ENG42.planeIdentifier}`);
		expect(result).toContain(`plane_url: ${ENG42.planeUrl}`);
	});

	test("preserves all other content exactly (frontmatter, body, acceptance criteria)", () => {
		const content = readFixture("single-story.md");
		const updates = [
			{ title: "As a user, I want to log in so that I can access my account", ...ENG42 },
		];

		const result = writeBackIds("single-story.md", content, updates);

		// Frontmatter preserved
		expect(result).toContain('project: "Q1 2026 Release"');

		// Metadata preserved
		expect(result).toContain("priority: high");
		expect(result).toContain("labels: [Feature, Auth]");
		expect(result).toContain("estimate: 3");
		expect(result).toContain("assignee: jane@company.com");
		expect(result).toContain("status: Backlog");

		// Body preserved
		expect(result).toContain("User should be able to log in with their email and password.");
		expect(result).toContain("The system should support rate limiting after 5 failed attempts.");

		// Acceptance criteria preserved
		expect(result).toContain("### Acceptance Criteria");
		expect(result).toContain("- [ ] User can enter email and password on the login page");
		expect(result).toContain("- [ ] Account locks after 5 consecutive failed attempts");
	});

	test("inserts YAML block after H2 for story that had no YAML block", () => {
		const content = readFixture("minimal-story.md");
		const updates = [
			{
				title: "As a user, I want to view my profile",
				planeId: "cccc9999-9999-4999-8999-999999999999",
				planeIdentifier: "ENG-99",
				planeUrl: "https://app.plane.so/ws/projects/p/issues/cccc9999-9999-4999-8999-999999999999",
			},
		];

		const result = writeBackIds("minimal-story.md", content, updates);

		expect(result).toContain("plane_id: cccc9999-9999-4999-8999-999999999999");
		expect(result).toContain("plane_identifier: ENG-99");
		// Body content should still be present
		expect(result).toContain("View user profile details including name, email, and avatar.");
		expect(result).toContain("### Acceptance Criteria");

		// The YAML block should come after the H2 heading
		const h2Index = result.indexOf("## As a user, I want to view my profile");
		const yamlBlockIndex = result.indexOf("```yaml");
		const bodyIndex = result.indexOf("View user profile details");
		expect(yamlBlockIndex).toBeGreaterThan(h2Index);
		expect(bodyIndex).toBeGreaterThan(yamlBlockIndex);
	});

	test("handles multi-story file - updates correct story, leaves others unchanged", () => {
		const content = readFixture("multi-story.md");
		const updates = [
			{ title: "As a user, I want to reset my password so that I can regain access", ...ENG43 },
		];

		const result = writeBackIds("multi-story.md", content, updates);

		// Second story should be updated
		expect(result).toContain(`plane_id: ${ENG43.planeId}`);
		expect(result).toContain(`plane_identifier: ${ENG43.planeIdentifier}`);

		// First story should remain unchanged (plane_id still empty)
		const secondStoryStart = result.indexOf("## As a user, I want to reset my password");
		const firstStoryContent = result.slice(0, secondStoryStart);
		expect(firstStoryContent).not.toContain(ENG43.planeId);
		expect(firstStoryContent).toContain("plane_id:");
		const firstYamlMatch = firstStoryContent.match(/plane_id:(.*)/);
		expect(firstYamlMatch).not.toBeNull();
		expect(firstYamlMatch?.[1]?.trim()).toBe("");

		// Both story bodies should be intact
		expect(result).toContain("User should be able to log in with their email and password.");
		expect(result).toContain("User should be able to reset their password via email link.");
	});

	test("updates multiple stories in one call", () => {
		const content = readFixture("multi-story.md");
		const updates = [
			{ title: "As a user, I want to log in so that I can access my account", ...ENG42 },
			{ title: "As a user, I want to reset my password so that I can regain access", ...ENG43 },
		];

		const result = writeBackIds("multi-story.md", content, updates);

		expect(result).toContain(`plane_id: ${ENG42.planeId}`);
		expect(result).toContain(`plane_identifier: ${ENG42.planeIdentifier}`);
		expect(result).toContain(`plane_id: ${ENG43.planeId}`);
		expect(result).toContain(`plane_identifier: ${ENG43.planeIdentifier}`);
	});
});
