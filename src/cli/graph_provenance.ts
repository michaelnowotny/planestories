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
