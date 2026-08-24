import type { AtlasSourceStamp } from "../atlas/render.ts";
import { formatElapsedAge } from "./board_cache.ts";
import type { GraphSourceProvenance } from "./graph_source.ts";

/** Human provenance footer shared by every graph-backed answer. */
export function formatGraphSourceProvenance(
	provenance: GraphSourceProvenance,
	now: Date = new Date(),
): string {
	if (provenance.kind === "snapshot") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · snapshot taken ${provenance.takenAt}`;
	}
	if (provenance.kind === "cache") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · cached ${formatElapsedAge(provenance.fetchedAt, now)} ago (fetched ${provenance.fetchedAt})`;
	}
	if (provenance.kind === "live") {
		return `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug} · live`;
	}
	return `${provenance.project} · file ${provenance.path}`;
}

/** Board identity in absolute terms only — no relative age, ever. */
function absoluteDescription(provenance: GraphSourceProvenance, observedAt: string | null): string {
	if (provenance.kind === "file") return `${provenance.project} · file ${provenance.path}`;
	const where = `${provenance.project} board · ${provenance.baseUrl} · workspace ${provenance.workspaceSlug}`;
	if (provenance.kind === "live") return `${where} · live, read ${observedAt}`;
	return `${where} · ${provenance.kind} taken ${observedAt}`;
}

/**
 * The same provenance, shaped for embedding INSIDE a durable artifact.
 *
 * `atlas.html` and `atlas.json` outlive by weeks the stderr line announcing
 * their age — which was the whole argument for printing an age. `observedAt` is
 * null for a stories file because the file IS the state; it is never filled in
 * with "now" to make the field look populated.
 *
 * Deliberately carries NO `renderedAt`. A wall-clock render stamp broke the
 * tested guarantee that two atlas runs over the same input are byte-identical —
 * so every atlas would differ from every other, and a diff would stop meaning
 * "the board changed". The file's own mtime answers "when was this written"; a
 * stamp inside it must answer only "how old is the STATE".
 */
export function graphSourceStamp(
	provenance: GraphSourceProvenance,
	renderedAt: Date = new Date(),
): AtlasSourceStamp {
	const observedAt =
		provenance.kind === "snapshot"
			? provenance.takenAt
			: provenance.kind === "cache"
				? provenance.fetchedAt
				: provenance.kind === "live"
					? renderedAt.toISOString()
					: null;
	return {
		kind: provenance.kind,
		project: provenance.project,
		observedAt,
		// NOT `formatGraphSourceProvenance`: that renders a RELATIVE age ("cached
		// 3h ago") for a human reading stderr now. Frozen into a file, that
		// sentence is false a week later — the exact confusion this stamp exists
		// to remove, smuggled back in via prose.
		description: absoluteDescription(provenance, observedAt),
	};
}
