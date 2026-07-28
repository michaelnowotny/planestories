import { describe, expect, test } from "bun:test";
import {
	type AtlasGraph,
	buildAtlasFromBoard,
	buildAtlasFromFile,
} from "../../../src/atlas/model.ts";
import type { PlaneIssueRelations } from "../../../src/plane/client.ts";
import { fetchProjectIndex } from "../../../src/plane/issues.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

/** Resolve a graph's edges to human identifiers for readable assertions. */
function edgeTriples(g: AtlasGraph): string[] {
	const idToIdent = new Map<string, string | null>();
	const walk = (n: (typeof g.nodes)[number]): void => {
		idToIdent.set(n.id, n.identifier);
		for (const c of n.children) walk(c);
	};
	for (const n of g.nodes) walk(n);
	return g.edges
		.map((e) => `${idToIdent.get(e.source)} ${e.type} ${idToIdent.get(e.target)}`)
		.sort();
}

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

	test("keeps case-mismatched parent identifiers unlinked and non-epic", () => {
		const graph = buildAtlasFromFile(
			[
				"## Potential parent",
				"",
				"```yaml",
				"plane_identifier: DATA-1",
				"```",
				"",
				"Parent scope.",
				"",
				"## Unlinked child",
				"",
				"```yaml",
				"plane_identifier: DATA-2",
				"parent: data-1",
				"```",
				"",
				"### Acceptance Criteria",
				"- [ ] It works",
			].join("\n"),
			"x.md",
		);

		expect(graph.nodes).toHaveLength(2);
		expect(graph.counts.epics).toBe(0);
		expect(graph.nodes[0]?.kind).toBe("story");
		expect(graph.nodes[0]?.children).toEqual([]);
		expect(graph.nodes[1]?.identifier).toBe("DATA-2");
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

describe("dependency edges", () => {
	test("file source: blocks is directed, relates is undirected, mirror is deduped", () => {
		const file = [
			"## A",
			"",
			"```yaml",
			"plane_identifier: DATA-1",
			"blocks: [DATA-2]",
			"relates_to: [DATA-3]",
			"```",
			"",
			"Body one.",
			"",
			"## B",
			"",
			"```yaml",
			"plane_identifier: DATA-2",
			"blocked_by: [DATA-1]",
			"```",
			"",
			"Body two.",
			"",
			"## C",
			"",
			"```yaml",
			"plane_identifier: DATA-3",
			"```",
			"",
			"Body three.",
		].join("\n");
		const g = buildAtlasFromFile(file, "x.md");
		// A blocks B (declared from BOTH ends -> one edge); A relates C.
		expect(edgeTriples(g)).toEqual(["DATA-1 blocks DATA-2", "DATA-1 relates DATA-3"]);
		expect(g.counts.edges).toBe(2);
	});

	test("file source: a dependency on an unknown identifier is dropped", () => {
		const file = [
			"## A",
			"",
			"```yaml",
			"plane_identifier: DATA-1",
			"blocks: [DATA-999]",
			"```",
			"",
			"Body.",
		].join("\n");
		expect(buildAtlasFromFile(file, "x.md").edges).toEqual([]);
	});

	test("board source: relations become edges (blocked_by/blocking dedup, relates undirected)", async () => {
		const P = "p1";
		const c = makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [
					{ id: "a", sequence_id: 1, name: "A", state: { name: "Backlog", group: "backlog" } },
					{ id: "b", sequence_id: 2, name: "B", state: { name: "Backlog", group: "backlog" } },
					{ id: "d", sequence_id: 3, name: "D", state: { name: "Backlog", group: "backlog" } },
				],
			},
			relations: { a: { blocking: ["b"], relates_to: ["d"] } },
		}).client;
		const index = await fetchProjectIndex(c, P, "ENG");
		// The fake client mirrors relations, so a getRelations per item reflects both ends.
		const relationsById = new Map<string, PlaneIssueRelations>();
		for (const item of index.items) {
			relationsById.set(item.id, await c.getRelations(P, item.id));
		}
		const g = buildAtlasFromBoard(c, P, "ENG", "Proj", index, relationsById);
		expect(edgeTriples(g)).toEqual(["ENG-1 blocks ENG-2", "ENG-1 relates ENG-3"]);
		expect(g.counts.edges).toBe(2);
	});

	test("board source: no edges without relations (backward-compatible)", async () => {
		const P = "p1";
		const c = makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [{ id: "a", sequence_id: 1, name: "A", state: { name: "Backlog", group: "backlog" } }],
			},
		}).client;
		const index = await fetchProjectIndex(c, P, "ENG");
		expect(buildAtlasFromBoard(c, P, "ENG", "Proj", index).edges).toEqual([]);
	});
});
