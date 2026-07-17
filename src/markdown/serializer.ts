import type { FileFrontmatter, UserStory } from "../types.ts";

/**
 * Serialize an array of UserStory objects back to markdown format.
 *
 * Produces markdown matching the import template format:
 * - Optional file-level YAML frontmatter (---...---)
 * - H2 headings for each story
 * - Optional fenced YAML blocks with metadata
 * - Story body content
 */
export function serializeStories(stories: UserStory[], frontmatter?: FileFrontmatter): string {
	const parts: string[] = [];

	// Emit file-level frontmatter if provided
	if (frontmatter?.project) {
		parts.push("---");
		parts.push(`project: "${frontmatter.project}"`);
		parts.push("---");
		parts.push("");
	}

	for (let i = 0; i < stories.length; i++) {
		const story = stories[i] as UserStory;

		// H2 heading
		parts.push(`## ${story.title}`);
		parts.push("");

		// Fenced YAML block (only if there is metadata to emit)
		const yamlLines = buildYamlLines(story);
		if (yamlLines.length > 0) {
			parts.push("```yaml");
			for (const line of yamlLines) {
				parts.push(line);
			}
			parts.push("```");
			parts.push("");
		}

		// Story body
		if (story.body.trim()) {
			parts.push(story.body);
			parts.push("");
		}
	}

	return parts.join("\n");
}

/**
 * Build YAML metadata lines for a story.
 * Only includes fields that have meaningful values.
 */
function buildYamlLines(story: UserStory): string[] {
	const lines: string[] = [];

	// Plane identifiers come first when present
	if (story.planeId !== null) {
		lines.push(`plane_id: ${story.planeId}`);
	}
	if (story.planeIdentifier !== null) {
		lines.push(`plane_identifier: ${story.planeIdentifier}`);
	}
	if (story.planeUrl !== null) {
		lines.push(`plane_url: ${story.planeUrl}`);
	}
	if (story.planeHash !== null) {
		lines.push(`plane_hash: ${story.planeHash}`);
	}

	if (story.priority !== null) {
		lines.push(`priority: ${story.priority}`);
	}

	if (story.labels.length > 0) {
		lines.push(`labels: [${story.labels.join(", ")}]`);
	}

	if (story.estimate !== null) {
		lines.push(`estimate: ${story.estimate}`);
	}

	if (story.assignee !== null) {
		lines.push(`assignee: ${story.assignee}`);
	}

	if (story.status !== null) {
		lines.push(`status: ${story.status}`);
	}

	return lines;
}
