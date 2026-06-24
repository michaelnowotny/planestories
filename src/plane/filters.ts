import type { FetchedWorkItem } from "./issues.ts";

export interface WorkItemFilterInput {
	/** Human-readable identifiers to keep, e.g. ["BLOOM-8", "BLOOM-12"]. */
	identifiers?: string[];
	/** State name to keep (case-insensitive). */
	statusName?: string;
	/** Assignee email to keep (case-insensitive). */
	assigneeEmail?: string;
	/** external_source to keep (exact). */
	externalSource?: string;
	/** Label name to keep (case-insensitive). */
	label?: string;
}

/**
 * Filter fetched work items client-side.
 *
 * Plane's public REST list endpoint offers limited server-side filtering, so we
 * apply the export filters here against the already-resolved work items. The
 * project scope is handled upstream by querying a single project, so there is no
 * project filter at this layer.
 */
export function filterWorkItems(
	items: FetchedWorkItem[],
	input: WorkItemFilterInput,
	projectIdentifier: string,
): FetchedWorkItem[] {
	let result = items;

	if (input.identifiers && input.identifiers.length > 0) {
		const wanted = new Set(input.identifiers.map((id) => id.toUpperCase()));
		result = result.filter((item) =>
			wanted.has(`${projectIdentifier}-${item.sequenceId}`.toUpperCase()),
		);
	}

	if (input.statusName) {
		const needle = input.statusName.toLowerCase();
		result = result.filter((item) => item.stateName?.toLowerCase() === needle);
	}

	if (input.assigneeEmail) {
		const needle = input.assigneeEmail.toLowerCase();
		result = result.filter((item) => item.assigneeEmail?.toLowerCase() === needle);
	}

	if (input.externalSource) {
		result = result.filter((item) => item.externalSource === input.externalSource);
	}

	if (input.label) {
		const needle = input.label.toLowerCase();
		result = result.filter((item) => item.labels.some((l) => l.toLowerCase() === needle));
	}

	return result;
}
