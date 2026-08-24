import { describe, expect, test } from "bun:test";
import { buildAtlasFromFile } from "../../../src/atlas/model.ts";
import { atlasJsonPayload, renderAtlasHtml } from "../../../src/atlas/render.ts";
import { graphSourceStamp } from "../../../src/cli/graph_provenance.ts";
import type { GraphSourceProvenance } from "../../../src/cli/graph_source.ts";

/**
 * An `atlas.html` in a downloads folder outlives by weeks the stderr line that
 * announced its age — which was the entire argument for printing an age at all.
 * So the artifact carries its own provenance.
 *
 * It deliberately carries NO render timestamp. Adding one broke the existing
 * guarantee that two runs over the same input are byte-identical, which would
 * have made every atlas differ from every other and a diff stop meaning "the
 * board changed". `observedAt` answers how old the STATE is; the file's mtime
 * answers when the file was written.
 */

const STORIES = [
	"---",
	'project: "Platform"',
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
].join("\n");

const CACHE: GraphSourceProvenance = {
	kind: "cache",
	project: "Data Platform",
	projectId: "project-uuid",
	baseUrl: "https://plane.example",
	workspaceSlug: "archimedes",
	fetchedAt: "2026-08-23T09:00:00.000Z",
	itemCount: 2662,
};

const NOW = new Date("2026-08-23T12:00:00.000Z");

describe("the artifact records where its board state came from", () => {
	test("a cache stamp carries the OBSERVATION time, not the render time", () => {
		const stamp = graphSourceStamp(CACHE, NOW);
		expect(stamp.observedAt).toBe("2026-08-23T09:00:00.000Z");
		expect(stamp.kind).toBe("cache");
		expect(stamp.project).toBe("Data Platform");
		expect(stamp.description).toContain("plane.example");
		expect(stamp.description).toContain("3h ago");
		// The field that would have destroyed determinism.
		expect(Object.hasOwn(stamp, "renderedAt")).toBe(false);
	});

	test("a stories FILE has no observation time, and does not invent one", () => {
		// The file IS the state; "now" would be a fabricated timestamp dressed up
		// as a measurement.
		const stamp = graphSourceStamp({ kind: "file", project: "Platform", path: "s.md" }, NOW);
		expect(stamp.observedAt).toBeNull();
		expect(stamp.description).toContain("s.md");
	});

	test("the HTML shows the source, in static markup", () => {
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const html = renderAtlasHtml(graph, {
			coverage: { kind: "complete" },
			provenance: graphSourceStamp(CACHE, NOW),
		});
		// Static, not script-driven: the embedded script is the one part of the
		// file no test executes, and a review round once found a blank page caused
		// by editing it.
		expect(html).toContain("SOURCE: CACHE · DATA PLATFORM · 2026-08-23T09:00:00.000Z");
		// NOT a relative age: "1H AGO" frozen into a file still reads as fresh a
		// week later, which is the confusion the stamp exists to remove.
		expect(html).not.toContain("AGO");
	});

	test("an artifact with no stamp SAYS so rather than looking fresh", () => {
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const html = renderAtlasHtml(graph, { coverage: { kind: "complete" } });
		expect(html).toContain("SOURCE: NOT RECORDED IN THIS ARTIFACT");
	});

	test("the JSON payload carries the same stamp, and null when absent", () => {
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const stamp = graphSourceStamp(CACHE, NOW);
		expect(atlasJsonPayload(graph, { kind: "complete" }, stamp).provenance).toEqual(stamp);
		expect(atlasJsonPayload(graph, { kind: "complete" }).provenance).toBeNull();
	});

	test("the stamp does not collide with AtlasGraph.source", () => {
		// `AtlasGraph.source` already means "file" | "board". Keying the stamp
		// there would have silently overwritten it — tsc caught exactly that.
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const payload = atlasJsonPayload(graph, { kind: "complete" }, graphSourceStamp(CACHE, NOW));
		expect(payload.source).toBe("file");
		expect(payload.provenance?.kind).toBe("cache");
	});

	test("two renders of the same input are still byte-identical", () => {
		// The property the render stamp broke, pinned here so it cannot be
		// reintroduced by a future "add a timestamp" change.
		const graph = buildAtlasFromFile(STORIES, "stories.md");
		const options = {
			coverage: { kind: "complete" } as const,
			provenance: graphSourceStamp(CACHE, NOW),
		};
		expect(renderAtlasHtml(graph, options)).toBe(renderAtlasHtml(graph, options));
	});
});
