import { buildAcceptanceCriteria, joinBody, splitBody } from "../markdown/criteria.ts";
import type { PlaneClient } from "../plane/client.ts";
import type { FetchedWorkItem } from "../plane/issues.ts";
import type { UserStory } from "../types.ts";
import { hashStoryPayload } from "./story-hash.ts";

/** A criterion child has a parent and an external_id of the form `<parent>::ac<n>`. */
export function isCriterionChild(item: FetchedWorkItem): boolean {
	return Boolean(item.parent && item.externalId && /::ac\d+$/.test(item.externalId));
}

/** Positional index of a criterion child from its `::ac<n>` external id. */
export function criterionIndex(item: FetchedWorkItem): number {
	const match = item.externalId?.match(/::ac(\d+)$/);
	return match ? Number(match[1]) : 0;
}

/**
 * Convert a fetched Plane work item into a UserStory (the exporter's serialization
 * shape, also used by the importer to reconstruct board state for hash comparison).
 * When `children` (criterion sub-items) are provided, the body's acceptance criteria
 * are rebuilt from them, each child's completed state group rendering as a checked box.
 *
 * A `plane_hash` is computed the same way an import would, so:
 *  - an export writes it, making export->import round-trips start warm; and
 *  - the importer can compare a hashless-but-linked file against the board (adopt).
 * The hash reflects `syncCriteria` so it matches the corresponding invocation.
 */
export function boardItemToStory(
	client: PlaneClient,
	item: FetchedWorkItem,
	projectId: string,
	projectIdentifier: string,
	projectName: string,
	syncCriteria: boolean,
	children?: FetchedWorkItem[],
	parentIdentifier?: string | null,
	/** True when this item parents at least one non-criterion child (i.e. an epic). */
	isEpic?: boolean,
): UserStory {
	let body = item.description ?? "";

	if (children && children.length > 0) {
		const sorted = [...children].sort((a, b) => criterionIndex(a) - criterionIndex(b));
		const criteria = sorted.map((child) => ({
			text: child.name,
			checked: child.stateGroup === "completed",
		}));
		const narrative = splitBody(body).narrative;
		body = joinBody(narrative, buildAcceptanceCriteria(criteria));
	}

	const story: UserStory = {
		title: item.name,
		planeId: item.id,
		planeIdentifier: `${projectIdentifier}-${item.sequenceId}`,
		planeUrl: client.workItemWebUrl(projectId, item.id),
		planeHash: null,
		priority: item.priority ?? null,
		labels: item.labels,
		estimate: item.estimate ?? null,
		assignee: item.assigneeEmail ?? item.assigneeDisplayName ?? null,
		status: item.stateName ?? null,
		body,
		project: projectName,
		parent: parentIdentifier ?? null,
		kind: isCriterionChild(item) ? "criterion" : isEpic ? "epic" : "story",
		comment: null,
	};

	// Same effective-label set the common re-import sees (the item's own labels;
	// default/source labels are an import-time concern the board can't know).
	story.planeHash = hashStoryPayload(story, { syncCriteria, labels: story.labels });
	return story;
}
