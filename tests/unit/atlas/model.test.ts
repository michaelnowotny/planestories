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

describe("effortDays + priority (Cockpit model additions)", () => {
	test("file source: effort line + YAML priority flow onto the node", () => {
		const file = [
			"## Weighted story",
			"",
			"```yaml",
			"plane_identifier: DATA-1",
			"priority: high",
			"```",
			"",
			"A meaningful description.",
			"",
			"**Effort:** 2.5 dev-days",
			"",
			"### Acceptance Criteria",
			"- [ ] It works",
		].join("\n");
		const g = buildAtlasFromFile(file, "x.md");
		const story = g.nodes[0]!;
		expect(story.effortDays).toBe(2.5);
		expect(story.priority).toBe("high");
	});

	test("file source: absent effort/priority stay null (never coerced to 0)", () => {
		const g = buildAtlasFromFile(FILE, "x.md");
		const epic = g.nodes[0]!;
		const story = epic.children[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.priority).toBeNull();
		expect(epic.effortDays).toBeNull();
		expect(epic.priority).toBeNull();
	});

	test("board source: effort parsed from the description, priority from the item", async () => {
		const P = "p1";
		const c = makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [
					{
						id: "st",
						sequence_id: 1,
						name: "Story",
						priority: "high",
						description_html: "<p>Scope text.</p><p><strong>Effort:</strong> 3 dev-days</p>",
						state: { name: "Backlog", group: "backlog" },
					},
					{
						id: "bare",
						sequence_id: 2,
						name: "Bare story",
						state: { name: "Backlog", group: "backlog" },
					},
				],
			},
		}).client;
		const index = await fetchProjectIndex(c, P, "ENG");
		const g = buildAtlasFromBoard(c, P, "ENG", "Proj", index);
		const byIdent = new Map(g.nodes.map((n) => [n.identifier, n]));
		expect(byIdent.get("ENG-1")?.effortDays).toBe(3);
		expect(byIdent.get("ENG-1")?.priority).toBe("high");
		expect(byIdent.get("ENG-2")?.effortDays).toBeNull();
		expect(byIdent.get("ENG-2")?.priority).toBeNull();
	});
});

describe("board timestamps", () => {
	test("file source: createdAt and updatedAt are null because markdown has no board timestamps", () => {
		const graph = buildAtlasFromFile(FILE, "x.md");
		const epic = graph.nodes[0]!;
		const story = epic.children[0]!;

		expect(epic.createdAt).toBeNull();
		expect(epic.updatedAt).toBeNull();
		expect(story.createdAt).toBeNull();
		expect(story.updatedAt).toBeNull();
	});

	test("board source: carries UTC timestamps and keeps missing values null", async () => {
		const P = "p1";
		const c = makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [
					{
						id: "dated",
						sequence_id: 1,
						name: "Dated story",
						created_at: "2026-08-22T20:15:30-07:00",
						updated_at: "2026-08-23T04:05:06Z",
						state: { name: "Backlog", group: "backlog" },
					},
					{
						id: "undated",
						sequence_id: 2,
						name: "Undated story",
						state: { name: "Backlog", group: "backlog" },
					},
				],
			},
		}).client;
		const index = await fetchProjectIndex(c, P, "ENG");
		const graph = buildAtlasFromBoard(c, P, "ENG", "Proj", index);
		const byIdentifier = new Map(graph.nodes.map((node) => [node.identifier, node]));

		expect(byIdentifier.get("ENG-1")?.createdAt).toBe("2026-08-23T03:15:30.000Z");
		expect(byIdentifier.get("ENG-1")?.updatedAt).toBe("2026-08-23T04:05:06.000Z");
		expect(byIdentifier.get("ENG-2")?.createdAt).toBeNull();
		expect(byIdentifier.get("ENG-2")?.updatedAt).toBeNull();
	});
});

describe("assignee vocabulary (filter chips)", () => {
	test("collects distinct assignees, sorted, nulls excluded", async () => {
		const P = "p1";
		const c = makeFakeClient({
			projects: [{ id: P, name: "Proj", identifier: "ENG" }],
			workItems: {
				[P]: [
					{
						id: "a",
						sequence_id: 1,
						name: "A",
						state: { name: "Backlog", group: "backlog" },
						assignees: [{ email: "zoe@x.io" }],
					},
					{
						id: "b",
						sequence_id: 2,
						name: "B",
						state: { name: "Backlog", group: "backlog" },
						assignees: [{ email: "ann@x.io" }],
					},
					{
						id: "c",
						sequence_id: 3,
						name: "C",
						state: { name: "Backlog", group: "backlog" },
						assignees: [{ email: "zoe@x.io" }],
					},
					{ id: "d", sequence_id: 4, name: "D", state: { name: "Backlog", group: "backlog" } },
				],
			},
		}).client;
		const index = await fetchProjectIndex(c, P, "ENG");
		const g = buildAtlasFromBoard(c, P, "ENG", "Proj", index);
		expect(g.assignees).toEqual(["ann@x.io", "zoe@x.io"]);
	});

	test("file source: empty assignee vocabulary when none are set", () => {
		expect(buildAtlasFromFile(FILE, "x.md").assignees).toEqual([]);
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

/**
 * A parent CYCLE used to make work silently disappear.
 *
 * `assembleTree` treats "has a resolvable parent" as "is not a root", so two
 * items that name each other are attached to one another and never reach the
 * root list. Measured before the fix, a two-story file whose stories are each
 * other's parent produced `roots: 0` and every count zero — `count` printing
 * `0 of 0 stories` for a file with two stories in it, with no warning anywhere.
 *
 * That is the null-ban in structural form: the absence of a representable tree
 * became a confident, valid-looking empty answer. Refusing is the house
 * behaviour; dropping the rows is not.
 */
describe("parent cycles", () => {
	const CYCLE = [
		"---",
		'project: "P"',
		"---",
		"",
		"## As a user, I want A, so that I benefit",
		"",
		"```yaml",
		"plane_identifier: P-1",
		"parent: P-2",
		"```",
		"",
		"Body A, long enough to be a real story body.",
		"",
		"## As a user, I want B, so that I benefit",
		"",
		"```yaml",
		"plane_identifier: P-2",
		"parent: P-1",
		"```",
		"",
		"Body B, long enough to be a real story body.",
		"",
	].join("\n");

	test("a mutually-parented pair refuses instead of vanishing", () => {
		expect(() => buildAtlasFromFile(CYCLE, "cycle.md")).toThrow(/cycle/i);
	});

	test("the refusal names the items involved, so it can be fixed", () => {
		try {
			buildAtlasFromFile(CYCLE, "cycle.md");
			throw new Error("expected a refusal");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("P-1");
			expect(message).toContain("P-2");
		}
	});

	test("an ordinary parent chain still assembles", () => {
		// The same file with the loop broken: P-1 parentless, P-2 its child. The
		// guard must reject cycles without rejecting nesting.
		const nested = CYCLE.replace("plane_identifier: P-1\nparent: P-2", "plane_identifier: P-1");
		const graph = buildAtlasFromFile(nested, "nested.md");
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0]?.identifier).toBe("P-1");
		expect(graph.nodes[0]?.children).toHaveLength(1);
		expect(graph.nodes[0]?.children[0]?.identifier).toBe("P-2");
	});
});
