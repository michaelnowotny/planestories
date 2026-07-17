import { describe, expect, test } from "bun:test";
import { serializeStories } from "../../../src/markdown/serializer.ts";
import type { FileFrontmatter, UserStory } from "../../../src/types.ts";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		title: "As a user, I want to log in so that I can access my account",
		planeId: null,
		planeIdentifier: null,
		planeUrl: null,
		planeHash: null,
		priority: null,
		labels: [],
		estimate: null,
		assignee: null,
		status: null,
		body: "User should be able to log in.\n\n### Acceptance Criteria\n\n- [ ] Login works",
		project: null,
		parent: null,
		kind: null,
		comment: null,
		...overrides,
	};
}

describe("serializeStories", () => {
	test("emits kind (criterion) and parent, but omits kind for a plain story", () => {
		const withKind = serializeStories([makeStory({ kind: "criterion", parent: "ENG-3" })]);
		expect(withKind).toContain("kind: criterion");
		expect(withKind).toContain("parent: ENG-3");

		const plain = serializeStories([makeStory({ kind: "story" })]);
		expect(plain).not.toContain("kind:");
		expect(plain).not.toContain("parent:");
	});

	test("serializes single UserStory to markdown", () => {
		const story = makeStory({
			priority: "high",
			labels: ["Feature", "Auth"],
			estimate: 3,
			assignee: "jane@company.com",
			status: "Backlog",
		});

		const result = serializeStories([story]);

		expect(result).toContain("## As a user, I want to log in so that I can access my account");
		expect(result).toContain("```yaml");
		expect(result).toContain("priority: high");
		expect(result).toContain("labels: [Feature, Auth]");
		expect(result).toContain("estimate: 3");
		expect(result).toContain("assignee: jane@company.com");
		expect(result).toContain("status: Backlog");
		expect(result).toContain("```");
		expect(result).toContain("User should be able to log in.");
		expect(result).toContain("### Acceptance Criteria");
	});

	test("serializes array of UserStory[] with file frontmatter", () => {
		const frontmatter: FileFrontmatter = { project: "Q1 2026 Release" };
		const stories = [
			makeStory({ priority: "high" }),
			makeStory({
				title: "As a user, I want to reset my password",
				priority: "medium",
				body: "Password reset flow.\n\n### Acceptance Criteria\n\n- [ ] Reset works",
			}),
		];

		const result = serializeStories(stories, frontmatter);

		// Frontmatter
		expect(result).toMatch(/^---\n/);
		expect(result).toContain('project: "Q1 2026 Release"');
		expect(result).toContain("---\n");

		// Both stories present
		expect(result).toContain("## As a user, I want to log in so that I can access my account");
		expect(result).toContain("## As a user, I want to reset my password");
	});

	test("omits null/empty optional fields from YAML blocks", () => {
		const story = makeStory({
			priority: "high",
			// labels is empty [], assignee is null, status is null, estimate is null
		});

		const result = serializeStories([story]);

		expect(result).toContain("priority: high");
		expect(result).not.toContain("assignee:");
		expect(result).not.toContain("status:");
		expect(result).not.toContain("estimate:");
		// labels is empty so should be omitted
		expect(result).not.toMatch(/^labels:/m);
	});

	test("includes plane ids when present", () => {
		const story = makeStory({
			planeId: "11111111-1111-4111-8111-111111111111",
			planeIdentifier: "ENG-42",
			planeUrl: "https://app.plane.so/ws/projects/p/issues/11111111-1111-4111-8111-111111111111",
			priority: "high",
		});

		const result = serializeStories([story]);

		expect(result).toContain("plane_id: 11111111-1111-4111-8111-111111111111");
		expect(result).toContain("plane_identifier: ENG-42");
		expect(result).toContain("plane_url: https://app.plane.so/ws/projects/p/issues/");
	});

	test("produces valid markdown that can be round-tripped through the parser", () => {
		const frontmatter: FileFrontmatter = { project: "Q1 2026 Release" };
		const story = makeStory({
			priority: "high",
			labels: ["Feature", "Auth"],
			estimate: 3,
			assignee: "jane@company.com",
			status: "Backlog",
		});

		const result = serializeStories([story], frontmatter);

		// Structural checks
		expect(result).toMatch(/^---\n/);
		expect(result).toContain("\n## ");
		expect(result).toContain("```yaml\n");
		expect(result).toContain("\n```\n");
		expect(result.endsWith("\n")).toBe(true);
	});

	test("handles story with no metadata - no YAML block emitted", () => {
		const story = makeStory();
		// All metadata fields are null/empty

		const result = serializeStories([story]);

		expect(result).toContain("## As a user, I want to log in so that I can access my account");
		expect(result).not.toContain("```yaml");
		expect(result).toContain("User should be able to log in.");
	});
});
