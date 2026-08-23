import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncompleteGraphError, resolveGraph } from "../../../src/cli/graph_source.ts";
import { serializeSnapshot } from "../../../src/replicate/snapshot.ts";
import { sampleSnapshot } from "../replicate/fixtures.ts";

/**
 * `graph_source.ts` is the single graph-construction path AND the home of the
 * `DependencyCoverage` contract — the thing four review rounds converged on,
 * after `trend` and `diff` were each found silently discarding the completeness
 * field. It had NO tests of its own: its consumers were covered, the module
 * carrying the invariant was not.
 *
 * These pin the contract itself: which coverage a source yields, and that the
 * graph cannot be reached without answering for it.
 */

let directory: string;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "planestories-graphsrc-"));
	// `loadConfig` reads process.env directly; a stray PLANE_* would change which
	// path this takes (HANDOFF §9.5a #2).
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) {
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PLANE_")) delete process.env[key];
	}
	for (const [key, value] of Object.entries(SAVED)) {
		if (value !== undefined) process.env[key] = value;
		delete SAVED[key];
	}
});

const STORIES = [
	"---",
	'project: "P"',
	"---",
	"",
	"## As a user, I want a thing, so that I benefit",
	"",
	"```yaml",
	"plane_identifier: P-1",
	"```",
	"",
	"**Effort:** 2 dev-days",
	"",
	"Body text long enough to be meaningful.",
	"",
	"### Acceptance Criteria",
	"- [ ] it works",
	"",
].join("\n");

function storiesFile(): string {
	const path = join(directory, "stories.md");
	writeFileSync(path, STORIES);
	return path;
}

function snapshotFile(): string {
	const path = join(directory, "board.snapshot.json");
	writeFileSync(path, serializeSnapshot(sampleSnapshot()));
	return path;
}

describe("resolveGraph — coverage contract", () => {
	test("a stories FILE is complete by construction", async () => {
		// Its `blocks:` lines are the whole dependency structure — nothing was
		// fetched, and nothing was skipped either.
		const source = await resolveGraph({ file: storiesFile() });
		expect(source.coverage).toEqual({ kind: "complete" });
		expect(source.requireCompleteGraph("a test").nodes.length).toBeGreaterThan(0);
	});

	test("a snapshot read with the sweep ON is complete", async () => {
		const source = await resolveGraph({ fromSnapshot: snapshotFile(), json: true });
		expect(source.coverage).toEqual({ kind: "complete" });
	});

	test("`dependencies: false` yields SKIPPED, not complete-with-no-edges", async () => {
		// The defect this exists to prevent: `--no-dependencies` left
		// `relationFailures` at 0, which read as "we looked and found nothing" and
		// rendered as a statement about the board. Absence of the question is not
		// its answer.
		const source = await resolveGraph({
			fromSnapshot: snapshotFile(),
			dependencies: false,
			json: true,
		});
		expect(source.coverage).toEqual({ kind: "skipped" });
	});

	test("requireCompleteGraph REFUSES a skipped sweep, and names the purpose", async () => {
		const source = await resolveGraph({
			fromSnapshot: snapshotFile(),
			dependencies: false,
			json: true,
		});
		expect(() => source.requireCompleteGraph("the dependency floor")).toThrow(IncompleteGraphError);
		try {
			source.requireCompleteGraph("the dependency floor");
		} catch (error) {
			// The message has to say WHICH figure was refused and why, because it is
			// what the operator sees instead of a number.
			expect((error as Error).message).toContain("the dependency floor");
			expect((error as Error).message).toMatch(/were not fetched|no edges/);
		}
	});

	test("acceptPartialGraph still returns the graph — the reason is for the reader", async () => {
		// `atlas` uses this: a map with some edges missing is still a useful map.
		// The argument is not consulted at runtime; it exists so the choice is
		// visible at the call site instead of being the silent default it once was.
		const source = await resolveGraph({
			fromSnapshot: snapshotFile(),
			dependencies: false,
			json: true,
		});
		expect(source.acceptPartialGraph("a map is legible with some edges missing")).toBeDefined();
	});

	test("IncompleteGraphError carries the coverage, so a caller can explain it", () => {
		const partial = new IncompleteGraphError({ kind: "partial", failures: 3 }, "a floor");
		expect(partial.coverage).toEqual({ kind: "partial", failures: 3 });
		expect(partial.message).toContain("3 relation lookup");
		expect(partial.name).toBe("IncompleteGraphError");

		const skipped = new IncompleteGraphError({ kind: "skipped" }, "a floor");
		// A skipped sweep and a failed one are different situations and must not
		// produce the same sentence — one is a flag the user passed, the other is
		// the instance rate-limiting them.
		expect(skipped.message).not.toEqual(partial.message);
	});

	test("there is NO `graph` property — the question cannot be destructured away", async () => {
		// The structural point of the module. `const { graph } = await resolveGraph()`
		// is what `trend` and `diff` were both doing while discarding completeness;
		// it no longer type-checks, and this pins the runtime shape too.
		const source = await resolveGraph({ file: storiesFile() });
		expect(Object.hasOwn(source, "graph")).toBe(false);
		expect(typeof source.requireCompleteGraph).toBe("function");
		expect(typeof source.acceptPartialGraph).toBe("function");
		expect(typeof source.requireCachedWorkItems).toBe("function");
	});
});
