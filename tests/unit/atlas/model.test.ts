import { describe, expect, test } from "bun:test";
import { buildAtlasFromBoard, buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const FILE = `---
project: "Q1"
---

## The epic

\`\`\`yaml
kind: epic
plane_identifier: DATA-1
\`\`\`

### Why is this needed?
Because researchers need it.

## As a user, I want X, so that Y

\`\`\`yaml
plane_identifier: DATA-2
parent: DATA-1
status: Done
labels: [API]
\`\`\`

Enough description here to be meaningful to the reader.

### Acceptance Criteria
- [x] a concrete criterion returning HTTP 400
- [ ] another concrete criterion
`;

describe("buildAtlasFromFile", () => {
	test("builds an epic with a nested story, criteria, and counts", () => {
		const g = buildAtlasFromFile(FILE, "x.md");
		expect(g.project).toBe("Q1");
		expect(g.source).toBe("file");
		expect(g.counts.epics).toBe(1);
		expect(g.counts.stories).toBe(1);
		expect(g.counts.criteria).toBe(2);

		expect(g.nodes).toHaveLength(1);
		const epic = g.nodes[0]!;
		expect(epic.kind).toBe("epic");
		expect(epic.identifier).toBe("DATA-1");
		expect(epic.children).toHaveLength(1);

		const story = epic.children[0]!;
		expect(story.kind).toBe("story");
		expect(story.identifier).toBe("DATA-2");
		expect(story.statusGroup).toBe("completed");
		expect(story.labels).toEqual(["API"]);
		expect(story.criteria.map((c) => c.checked)).toEqual([true, false]);
	});

	test("collects labels for the filter chips", () => {
		expect(buildAtlasFromFile(FILE, "x.md").labels).toContain("API");
	});

	test("is deterministic — same input renders the same node ids", () => {
		const a = buildAtlasFromFile(FILE, "x.md");
		const b = buildAtlasFromFile(FILE, "x.md");
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("buildAtlasFromBoard", () => {
	const P = "p1";
	function client() {
		return makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [
					{
						id: "ep",
						sequence_id: 1,
						name: "Epic",
						state: { name: "In Progress", group: "started" },
					},
					{
						id: "st",
						sequence_id: 2,
						name: "Story",
						parent: "ep",
						state: { name: "Backlog", group: "backlog" },
						labels: [{ name: "API" }],
					},
					{
						id: "c0",
						sequence_id: 3,
						name: "a criterion",
						parent: "st",
						external_id: "story::ac0",
						external_source: "planestories",
						state: { name: "Done", group: "completed" },
					},
					{
						id: "c1",
						sequence_id: 4,
						name: "another criterion",
						parent: "st",
						external_id: "story::ac1",
						external_source: "planestories",
						state: { name: "Backlog", group: "backlog" },
					},
				],
			},
		}).client;
	}

	test("nests stories under epics, folds criteria, and links to Plane", async () => {
		const c = client();
		const index = await fetchProjectIndex(c, P, "ENG");
		const g = buildAtlasFromBoard(c, P, "ENG", "Proj", index);

		expect(g.source).toBe("board");
		expect(g.counts.epics).toBe(1);
		expect(g.counts.stories).toBe(1);
		expect(g.counts.criteria).toBe(2);

		const epic = g.nodes[0]!;
		expect(epic.kind).toBe("epic");
		expect(epic.identifier).toBe("ENG-1");

		const story = epic.children[0]!;
		expect(story.kind).toBe("story");
		expect(story.identifier).toBe("ENG-2");
		expect(story.statusGroup).toBe("backlog");
		expect(story.criteria.map((c2) => c2.checked)).toEqual([true, false]);
		expect(story.url).toContain("/issues/st");
	});
});
