export interface WriteBackUpdate {
	title: string;
	planeId: string;
	planeIdentifier: string;
	planeUrl: string;
	/**
	 * Content hash of the synced payload, stored as `plane_hash` (P0-1 skip-unchanged).
	 * Undefined when a follow-up step (criteria/comment) did not finish — the item is
	 * linked, but the hash is withheld so a re-run retries instead of skipping as unchanged.
	 */
	planeHash?: string;
}

/**
 * Clear the plane_id / plane_identifier / plane_url / plane_hash VALUES (keeping
 * the keys) for the given story titles. This is the inverse of write-back, used
 * by `delete` so a deleted-then-re-imported story is treated as new (a lingering
 * plane_hash must not cause a re-created story to be skipped as "unchanged").
 */
export function clearWriteBack(content: string, titles: string[]): string {
	if (titles.length === 0) {
		return content;
	}
	const wanted = new Set(titles);
	let currentTitle: string | null = null;

	return content
		.split("\n")
		.map((line) => {
			if (line.startsWith("## ")) {
				currentTitle = line.replace(/^## /, "").trim();
				return line;
			}
			if (currentTitle && wanted.has(currentTitle)) {
				const match = line.match(/^(\s*)(plane_id|plane_identifier|plane_url|plane_hash):/);
				if (match) {
					return `${match[1]}${match[2]}:`;
				}
			}
			return line;
		})
		.join("\n");
}

/** The YAML keys we upsert, in the order they should appear. */
const FIELD_ORDER: ReadonlyArray<keyof Omit<WriteBackUpdate, "title">> = [
	"planeId",
	"planeIdentifier",
	"planeUrl",
	"planeHash",
];

const FIELD_TO_YAML: Record<keyof Omit<WriteBackUpdate, "title">, string> = {
	planeId: "plane_id",
	planeIdentifier: "plane_identifier",
	planeUrl: "plane_url",
	planeHash: "plane_hash",
};

/**
 * Write-back plane_id, plane_identifier and plane_url into existing markdown
 * file content.
 *
 * This function takes the original file content and returns updated content
 * with the Plane identifiers filled in for the specified stories. It does NOT
 * write to disk -- the caller handles that.
 *
 * Strategy:
 * - Walk the content line-by-line, tracking the current H2 story
 * - For each update, find the matching story by title
 * - If the story has a fenced YAML block, update/insert the plane_* lines
 * - If the story has no YAML block, insert one after the H2 heading
 * - Reassemble the full content preserving everything else exactly
 */
export function writeBackIds(
	_filePath: string,
	content: string,
	updates: WriteBackUpdate[],
): string {
	if (updates.length === 0) {
		return content;
	}

	const updateMap = new Map<string, WriteBackUpdate>();
	for (const update of updates) {
		updateMap.set(update.title, update);
	}

	const lines = content.split("\n");
	const result: string[] = [];

	let currentTitle: string | null = null;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] as string;

		// Detect H2 heading
		if (line.startsWith("## ")) {
			currentTitle = line.replace(/^## /, "").trim();

			result.push(line);
			i++;

			if (updateMap.has(currentTitle)) {
				const update = updateMap.get(currentTitle) as WriteBackUpdate;

				// Look ahead past any blank lines to see if ```yaml comes next
				let lookAhead = i;
				while (lookAhead < lines.length && lines[lookAhead]?.trim() === "") {
					lookAhead++;
				}

				if (lookAhead < lines.length && lines[lookAhead]?.trim() === "```yaml") {
					// There IS a YAML block - update plane_* lines inside it.
					// Output any blank lines between H2 and ```yaml
					while (i < lookAhead) {
						result.push(lines[i] as string);
						i++;
					}

					// ```yaml opening line
					result.push(lines[i] as string);
					i++;

					const found = new Set<string>();
					while (i < lines.length && lines[i]?.trim() !== "```") {
						const yamlLine = lines[i] as string;
						const matchedField = FIELD_ORDER.find((field) =>
							yamlLine.match(new RegExp(`^${FIELD_TO_YAML[field]}:`)),
						);
						// Only rewrite a plane_* line when we have a value for it; an
						// undefined value (e.g. a withheld plane_hash) leaves the line as-is.
						if (matchedField && update[matchedField] !== undefined) {
							result.push(`${FIELD_TO_YAML[matchedField]}: ${update[matchedField]}`);
							found.add(matchedField);
						} else {
							result.push(yamlLine);
						}
						i++;
					}

					// Append any plane_* fields that weren't already present (skip undefined).
					for (const field of FIELD_ORDER) {
						if (!found.has(field) && update[field] !== undefined) {
							result.push(`${FIELD_TO_YAML[field]}: ${update[field]}`);
						}
					}

					// Closing ```
					if (i < lines.length) {
						result.push(lines[i] as string);
						i++;
					}
				} else {
					// No YAML block - insert one after the H2 heading (skip undefined fields).
					result.push("");
					result.push("```yaml");
					for (const field of FIELD_ORDER) {
						if (update[field] !== undefined) {
							result.push(`${FIELD_TO_YAML[field]}: ${update[field]}`);
						}
					}
					result.push("```");
				}
			}

			continue;
		}

		// Default: output line as-is
		result.push(line);
		i++;
	}

	return result.join("\n");
}
