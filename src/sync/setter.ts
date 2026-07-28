import { ConfigError } from "../errors.ts";
import type { PlaneClient } from "../plane/client.ts";
import { ensureComment } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { PlanePriority, ResolvedConfig } from "../types.ts";

export interface SetOptions {
	config: ResolvedConfig;
	identifiers: string[];
	project?: string;
	status?: string;
	priority?: PlanePriority;
	assignee?: string;
	/** Append an evidence note (commit SHA, metric before→after, …) as a comment. */
	evidence?: string;
}

export interface SetResult {
	identifier: string;
	action: "updated" | "failed";
	/** Evidence-comment outcome when --evidence was given. */
	evidence?: "posted" | "exists";
	error?: string;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * The idempotency marker for an evidence note: a content hash of the text, so
 * re-running with the SAME evidence is a no-op (dedup) while DIFFERENT evidence
 * appends a new comment — an append-only, deduplicated evidence trail.
 */
export function evidenceMarker(evidence: string): string {
	return `planestories:evidence:${Bun.hash(evidence.trim()).toString(16)}`;
}

export interface SetSummary {
	results: SetResult[];
	updated: number;
	failed: number;
}

interface RawItem {
	id: string;
	sequence_id: number;
}

/**
 * Update fields (status/priority/assignee) on existing work items addressed by
 * their human identifier (e.g. "BLOOM-12"). A faster path than editing YAML and
 * re-importing when you just want to move a card's state.
 */
export async function setWorkItems(client: PlaneClient, options: SetOptions): Promise<SetSummary> {
	if (!options.status && !options.priority && !options.assignee && !options.evidence) {
		throw new ConfigError(
			"set requires at least one of --status, --priority, --assignee, or --evidence.",
		);
	}

	const resolver = new Resolver(client);
	const projectName = options.project ?? options.config.defaultProject;
	if (!projectName) {
		throw new ConfigError("set requires --project (or a configured defaultProject).");
	}
	const project = await resolver.resolveProject(projectName);

	// Map human identifiers (PROJ-N) to work item UUIDs.
	const items = await client.listWorkItems<RawItem>(project.id);
	const byIdentifier = new Map<string, string>();
	for (const item of items) {
		byIdentifier.set(`${project.identifier}-${item.sequence_id}`.toUpperCase(), item.id);
	}

	const results: SetResult[] = [];
	for (const identifier of options.identifiers) {
		const id = byIdentifier.get(identifier.toUpperCase());
		if (!id) {
			results.push({ identifier, action: "failed", error: "work item not found in project" });
			continue;
		}
		try {
			const body: Record<string, unknown> = {};
			if (options.priority) {
				body.priority = options.priority;
			}
			if (options.assignee) {
				const assigneeId = await resolver.resolveAssigneeId(project.id, options.assignee);
				if (!assigneeId) {
					throw new ConfigError(`assignee "${options.assignee}" not found`);
				}
				body.assignees = [assigneeId];
			}
			if (options.status) {
				const stateId = await resolver.resolveStateId(project.id, options.status);
				if (!stateId) {
					throw new ConfigError(`status "${options.status}" not found in project`);
				}
				body.state = stateId;
			}
			// Only PATCH when a field actually changed (evidence-only calls skip it).
			if (Object.keys(body).length > 0) {
				await client.updateWorkItem(project.id, id, body);
			}
			const result: SetResult = { identifier, action: "updated" };
			if (options.evidence) {
				const marker = evidenceMarker(options.evidence);
				const html = `<p>${escapeHtml(options.evidence.trim())} <sub>[${marker}]</sub></p>`;
				result.evidence = await ensureComment(client, project.id, id, marker, html);
			}
			results.push(result);
		} catch (error) {
			results.push({
				identifier,
				action: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		results,
		updated: results.filter((r) => r.action === "updated").length,
		failed: results.filter((r) => r.action === "failed").length,
	};
}
