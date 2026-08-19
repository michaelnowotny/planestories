import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { atlasJsonPayload, renderAtlasHtml } from "../../../src/atlas/render.ts";

/**
 * `atlas --json` is a DOCUMENTED, machine-facing output format with, until now,
 * no coverage at all: tests/unit/atlas exercised the model (buildAtlasFrom*),
 * which cannot prove the command emits anything. That is the "wrong layer" trap
 * in docs/HANDOFF.md §10b — a green model suite over an output nobody verifies.
 *
 * These tests run the REAL CLI and assert the contract external tooling depends
 * on, including the load-bearing invariant in docs/ATLAS.md: the JSON is *the
 * exact graph the cockpit renders*, "so external tooling and the HTML can never
 * disagree."
 */

// NOTE the key is `plane_identifier:`, not `identifier:` — the latter parses to a
// story with a null identifier that links to nothing, which is exactly how the
// first draft of this fixture silently produced an empty graph.
const STORIES = [
	"---",
	'project: "Platform"',
	"---",
	"",
	"## The platform epic",
	"",
	"```yaml",
	"kind: epic",
	"plane_identifier: ENG-1",
	"```",
	"",
	"### Why is this needed?",
	"Because the platform needs a spine.",
	"",
	"## As a dev, I want ingestion, so that data lands",
	"",
	"```yaml",
	"plane_identifier: ENG-2",
	"parent: ENG-1",
	"priority: high",
	"blocked_by: [ENG-3]",
	"```",
	"",
	"**Effort:** 2.5 dev-days",
	"",
	"Ingestion pulls files and writes rows into the store.",
	"",
	"### Acceptance Criteria",
	"- [ ] Rows land within 5 minutes",
	"- [x] Failures are retried three times",
	"",
	"## As a dev, I want storage, so that rows persist",
	"",
	"```yaml",
	"plane_identifier: ENG-3",
	"parent: ENG-1",
	"```",
	"",
	"Storage keeps rows durable across restarts and reboots.",
	"",
	"### Acceptance Criteria",
	"- [ ] A restart loses no rows",
	"",
].join("\n");

function runCli(args: string[], cwd: string): { code: number; out: string; err: string } {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	// Hermetic: strip PLANE_* so a gitignored .env on the dev box cannot make an
	// offline test pass for a reason a fresh clone would not reproduce.
	const env: Record<string, string> = { FORCE_COLOR: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawnSync(["bun", "run", cli, ...args], { env, cwd });
	return {
		code: proc.exitCode ?? -1,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function withFixture<T>(fn: (dir: string, storiesPath: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "planestories-atlasjson-"));
	try {
		const storiesPath = join(dir, "stories.md");
		writeFileSync(storiesPath, STORIES);
		return fn(dir, storiesPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("atlas --json — the CLI contract", () => {
	test("emits parseable JSON, not HTML, and says where it went", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			const r = runCli(["atlas", stories, "--json", "-o", out], dir);
			expect(r.code).toBe(0);

			const text = readFileSync(out, "utf8");
			// The discriminating assertion: with --json this file must NOT be a page.
			expect(text).not.toContain("<!doctype");
			expect(text).not.toContain("const GRAPH =");
			const graph = JSON.parse(text);
			expect(graph.source).toBe("file");
			expect(graph.project).toBeString();
		});
	});

	test("without --json the SAME invocation writes HTML (the flag is what switches)", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "page.html");
			expect(runCli(["atlas", stories, "-o", out], dir).code).toBe(0);
			const text = readFileSync(out, "utf8");
			expect(text).toContain("const GRAPH =");
			expect(() => JSON.parse(text)).toThrow();
		});
	});

	test("carries every documented top-level key", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			runCli(["atlas", stories, "--json", "-o", out], dir);
			const graph = JSON.parse(readFileSync(out, "utf8"));
			// docs/ATLAS.md promises these to external tooling; dropping one silently
			// breaks a consumer that has no way to know the shape changed.
			for (const key of [
				"project",
				"source",
				"nodes",
				"edges",
				"labels",
				"assignees",
				"statuses",
				"counts",
			]) {
				expect(graph).toHaveProperty(key);
			}
			for (const key of ["epics", "stories", "criteria", "flagged", "edges"]) {
				expect(graph.counts).toHaveProperty(key);
			}
		});
	});

	test("counts AGREE with the arrays they summarize", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			runCli(["atlas", stories, "--json", "-o", out], dir);
			const graph = JSON.parse(readFileSync(out, "utf8"));

			// A count that disagrees with its own data is worse than no count: a
			// consumer trusts the cheap field and never re-derives it.
			let epics = 0;
			let storyCount = 0;
			let criteria = 0;
			const walk = (nodes: Array<Record<string, unknown>>): void => {
				for (const n of nodes) {
					if (n.kind === "epic") epics++;
					else storyCount++;
					criteria += ((n.criteria as unknown[]) ?? []).length;
					walk((n.children as Array<Record<string, unknown>>) ?? []);
				}
			};
			walk(graph.nodes);

			expect(graph.counts.epics).toBe(epics);
			expect(graph.counts.stories).toBe(storyCount);
			expect(graph.counts.criteria).toBe(criteria);
			expect(graph.counts.edges).toBe(graph.edges.length);
		});
	});

	test("preserves the derived fields a raw board export does not contain", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			runCli(["atlas", stories, "--json", "-o", out], dir);
			const graph = JSON.parse(readFileSync(out, "utf8"));
			const epic = graph.nodes.find((n: { identifier: string }) => n.identifier === "ENG-1");
			const ingestion = epic.children.find((n: { identifier: string }) => n.identifier === "ENG-2");

			// These are the whole reason this format is not redundant with a snapshot:
			// none of them is a Plane field.
			expect(epic.kind).toBe("epic"); // INFERRED from structure
			expect(ingestion.effortDays).toBe(2.5); // parsed from a body line
			expect(ingestion.priority).toBe("high");
			expect(ingestion.criteria).toHaveLength(2);
			expect(ingestion.criteria[1].checked).toBe(true); // criterion state survives
			expect(ingestion.quality).not.toBeNull(); // spec-quality overlay
		});
	});

	test("absent effort/priority/assignee stay NULL, never 0 or empty string", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			runCli(["atlas", stories, "--json", "-o", out], dir);
			const graph = JSON.parse(readFileSync(out, "utf8"));
			const epic = graph.nodes.find((n: { identifier: string }) => n.identifier === "ENG-1");
			const storage = epic.children.find((n: { identifier: string }) => n.identifier === "ENG-3");

			// The house null-ban, at the machine-readable boundary: a consumer summing
			// effortDays must be able to tell "no estimate" from "estimated at zero".
			expect(storage.effortDays).toBeNull();
			expect(storage.priority).toBeNull();
			expect(storage.assignee).toBeNull();
		});
	});

	test("dependency edges are canonical: directed blocks, deduped, no dangling", () => {
		withFixture((dir, stories) => {
			const out = join(dir, "graph.json");
			runCli(["atlas", stories, "--json", "-o", out], dir);
			const graph = JSON.parse(readFileSync(out, "utf8"));

			// ENG-2 declares blocked_by: [ENG-3], so the edge points blocker -> blocked
			// exactly once. Raw board relations would carry Plane's auto-mirror too.
			expect(graph.edges).toHaveLength(1);
			const [edge] = graph.edges;
			expect(edge.type).toBe("blocks");
			const idOf = (identifier: string) => {
				let found: string | undefined;
				const walk = (nodes: Array<Record<string, unknown>>): void => {
					for (const n of nodes) {
						if (n.identifier === identifier) found = n.id as string;
						walk((n.children as Array<Record<string, unknown>>) ?? []);
					}
				};
				walk(graph.nodes);
				return found;
			};
			expect(edge.source).toBe(idOf("ENG-3"));
			expect(edge.target).toBe(idOf("ENG-2"));
		});
	});

	test("default output path lands in exports/, per the export rule", () => {
		withFixture((dir, stories) => {
			// No -o: the default must be exports/atlas.json at the resolved root, so
			// board-derived data cannot land somewhere a `git add -A` would sweep up.
			//
			// Assert on the FILE'S LOCATION, not on the printed message. The first
			// version of this test matched "exports" in stdout and stayed green when
			// the default was mutated to "../atlas.json" — because the printed path
			// still contained the word. Substring-matching a log line is not a test
			// of where a file went (HANDOFF §10b).
			const r = runCli(["atlas", stories, "--json"], dir);
			expect(r.code).toBe(0);
			expect(existsSync(join(dir, "exports", "atlas.json"))).toBe(true);
			expect(existsSync(join(dir, "atlas.json"))).toBe(false);
		});
	});

	test("is deterministic — two runs of the same input are byte-identical", () => {
		withFixture((dir, stories) => {
			const a = join(dir, "a.json");
			const b = join(dir, "b.json");
			runCli(["atlas", stories, "--json", "-o", a], dir);
			runCli(["atlas", stories, "--json", "-o", b], dir);
			// Diff-stability is a documented property (node ids reset per build); a
			// consumer diffing two dumps must see only real change.
			expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
		});
	});
});

describe("atlas --json — the HTML/JSON agreement invariant", () => {
	/**
	 * docs/ATLAS.md: the JSON emits "the exact graph the cockpit renders … so
	 * external tooling and the HTML can never disagree." That is the reason this
	 * format earns its keep over re-deriving a graph from a snapshot, so it needs
	 * a test rather than a promise.
	 */
	test("the emitted JSON is byte-identical to the graph embedded in the HTML", () => {
		withFixture((dir, stories) => {
			const jsonPath = join(dir, "graph.json");
			const htmlPath = join(dir, "page.html");
			runCli(["atlas", stories, "--json", "-o", jsonPath], dir);
			runCli(["atlas", stories, "-o", htmlPath], dir);

			const emitted = readFileSync(jsonPath, "utf8");
			const html = readFileSync(htmlPath, "utf8");

			// The renderer escapes "<" as < inside the embedded literal; undo that
			// to recover the original JSON text.
			const match = html.match(/const GRAPH = ([\s\S]*?);\n/);
			expect(match).not.toBeNull();
			const embedded = (match?.[1] as string).replace(/\\u003c/g, "<");

			expect(JSON.parse(embedded)).toEqual(JSON.parse(emitted));
		});
	});

	test("the invariant is enforced at the source: one graph feeds both renderers", () => {
		// A structural guard for the same property, independent of the CLI: the HTML
		// is a pure function of the graph the JSON path emits. If someone ever gives
		// renderAtlasHtml its own model call, this and the test above both break.
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const coverage = { kind: "complete" } as const;
		const html = renderAtlasHtml(graph, { coverage });
		const match = html.match(/const GRAPH = ([\s\S]*?);\n/);
		const embedded = (match?.[1] as string).replace(/\\u003c/g, "<");
		// Both artifacts are now built from `atlasJsonPayload`, so the agreement is
		// structural rather than maintained. When `dependencyCoverage` was added to
		// the JSON writer ALONE the two silently diverged, and the sibling test
		// above is what noticed.
		expect(JSON.parse(embedded)).toEqual(
			JSON.parse(JSON.stringify(atlasJsonPayload(graph, coverage))),
		);
	});
});
