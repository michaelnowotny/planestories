import type { AtlasGraph } from "../atlas/model.ts";
import { ConfigError } from "../errors.ts";
import { htmlToMarkdown } from "../markdown/html.ts";

/**
 * Printed when a command could have shown comments and did not.
 * A null count means the source never captured them — do not print 0.
 */
export function commentNotShownLine(count: number | null): string {
	if (count === null) return "comments not shown (not fetched)";
	if (count === 1) return "1 comment not shown";
	return `${count} comments not shown`;
}

export const COMMENTS_NOT_CAPTURED =
	"Comments were not captured. Run `planestories board fetch --with-comments`, or pass --from-snapshot.";

export interface ReadableComment {
	id: string;
	commentHtml: string;
	createdAt: string | null;
	createdBy: string | null;
}

/** Last path segment of a Plane work-item URL. That segment is the item id. */
export function workItemIdFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const path = (() => {
		try {
			return new URL(url).pathname;
		} catch {
			return url.split("?")[0]?.split("#")[0] ?? "";
		}
	})();
	const segment = path.split("/").filter(Boolean).at(-1);
	return segment && segment.length > 0 ? segment : null;
}

/** The work-item id of one atlas node, addressed the same way `show` finds it. */
export function workItemIdForIdentifier(graph: AtlasGraph, identifier: string): string | null {
	const want = identifier.trim().toUpperCase();
	const walk = (nodes: AtlasGraph["nodes"]): string | null => {
		for (const node of nodes) {
			if (node.identifier?.trim().toUpperCase() === want) return workItemIdFromUrl(node.url);
			const nested = walk(node.children);
			if (nested) return nested;
		}
		return null;
	};
	return walk(graph.nodes);
}

export function commentsCaptured(source: object): boolean {
	const fn = (source as { commentsCaptured?: () => boolean }).commentsCaptured;
	return typeof fn === "function" && fn.call(source) === true;
}

export async function readCapturedComments(
	source: object,
	projectId: string,
	workItemIds: readonly string[],
): Promise<ReadableComment[] | null> {
	if (!commentsCaptured(source)) return null;
	const list = (
		source as {
			listWorkItemComments?<T>(projectId: string, workItemId: string): Promise<T[]>;
		}
	).listWorkItemComments;
	if (typeof list !== "function") return null;
	const groups = await Promise.all(
		workItemIds.map((id) => list.call(source, projectId, id) as Promise<ReadableComment[]>),
	);
	return groups.flat();
}

/** Human comment bodies. Empty means the sweep ran and found none. */
export function renderCommentBodies(comments: readonly ReadableComment[]): string {
	if (comments.length === 0) return "Comments: none";
	const heading = comments.length === 1 ? "Comments (1):" : `Comments (${comments.length}):`;
	const blocks = [...comments]
		.sort(
			(a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
		)
		.map((comment) => {
			const when = comment.createdAt ?? "unknown time";
			const body = htmlToMarkdown(comment.commentHtml) || "(empty)";
			return `- ${when}\n  ${body.replaceAll("\n", "\n  ")}`;
		});
	return `${heading}\n${blocks.join("\n")}`;
}

/**
 * The line or the bodies for one answer.
 *
 * `workItemIds` null means this source did not capture comments. Callers must
 * not pass an empty list to mean "not fetched": an empty list is a captured
 * answer about nothing, and its count is a real zero.
 */
export async function commentAttachment(options: {
	source: object;
	projectId: string;
	workItemIds: readonly string[] | null;
	withComments: boolean;
}): Promise<string> {
	if (options.workItemIds === null || !commentsCaptured(options.source)) {
		if (options.withComments) throw new ConfigError(COMMENTS_NOT_CAPTURED);
		return commentNotShownLine(null);
	}
	const comments = await readCapturedComments(
		options.source,
		options.projectId,
		options.workItemIds,
	);
	if (comments === null) {
		if (options.withComments) throw new ConfigError(COMMENTS_NOT_CAPTURED);
		return commentNotShownLine(null);
	}
	if (options.withComments) return renderCommentBodies(comments);
	return commentNotShownLine(comments.length);
}
