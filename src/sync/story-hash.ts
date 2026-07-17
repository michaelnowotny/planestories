import { splitBody } from "../markdown/criteria.ts";
import { markdownToHtml } from "../markdown/html.ts";
import type { UserStory } from "../types.ts";
import { payloadHash } from "./content-hash.ts";

export interface StoryHashOptions {
	/** Whether acceptance criteria are synced as sub-items (matches --sync-criteria). */
	syncCriteria: boolean;
	/** Effective label names the import would apply (story + defaults + source label). */
	labels: string[];
}

/**
 * Compute a story's content hash exactly as an import would, so the importer
 * (which stores/compares it) and the exporter (which writes it so an
 * export->import round-trip starts warm) can never drift. This is the single
 * source of truth for the payload hash — do not inline the field assembly
 * anywhere else.
 *
 * The `syncCriteria` and `labels` inputs must mirror the invocation being hashed:
 * a round-trip is only "warm" when the export and the later import agree on the
 * --sync-criteria flag and on the effective label set (which they do in the
 * common case: no default/source labels, same flag).
 */
export function hashStoryPayload(story: UserStory, options: StoryHashOptions): string {
	const { narrative, criteria } = splitBody(story.body);
	const bodyForParent = options.syncCriteria ? narrative : story.body;
	return payloadHash({
		name: story.title,
		descriptionHtml: bodyForParent ? markdownToHtml(bodyForParent) : "",
		priority: story.priority,
		status: story.status,
		estimate: story.estimate,
		labels: options.labels,
		assignee: story.assignee,
		syncCriteria: options.syncCriteria,
		criteria: criteria.map((c) => ({ text: c.text, checked: c.checked })),
		parent: story.parent,
	});
}
