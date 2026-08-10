import { htmlToMarkdown, markdownToHtml } from "../markdown/html.ts";
import type { FetchedWorkItem } from "../plane/issues.ts";
import type { UserStory } from "../types.ts";

export interface FieldChange {
	field: string;
	from: string | null;
	to: string | null;
}

export interface StoryDiff {
	changes: FieldChange[];
	descriptionDiffers: boolean;
	descriptionPreview?: string;
	hashOnly: boolean;
}

function value(value: string | number | null | undefined): string | null {
	return value === undefined || value === null ? null : String(value);
}

function canonical(markdown: string): string {
	return htmlToMarkdown(markdownToHtml(markdown)).trim();
}

function labelsChange(fromValues: string[], toValues: string[]): FieldChange | null {
	const from = new Set(fromValues);
	const to = new Set(toValues);
	const parts = [
		...[...to]
			.filter((label) => !from.has(label))
			.sort()
			.map((label) => `+${label}`),
		...[...from]
			.filter((label) => !to.has(label))
			.sort()
			.map((label) => `-${label}`),
	];
	return parts.length ? { field: "labels", from: null, to: parts.join(" ") } : null;
}

export function diffStoryAgainstBoard(input: {
	story: UserStory;
	bodyForWrite: string;
	boardItem: FetchedWorkItem;
	boardParentIdentifier?: string | null;
	resolved: {
		stateName?: string | null;
		labels: string[];
		assigneeId?: string | null;
		assigneeDisplay?: string | null;
		parentIdentifier?: string | null;
	};
	hashMismatch?: boolean;
}): StoryDiff {
	const { story, boardItem, resolved } = input;
	const changes: FieldChange[] = [];
	const add = (
		field: string,
		from: string | number | null | undefined,
		to: string | number | null | undefined,
	) => {
		if (value(from) !== value(to)) changes.push({ field, from: value(from), to: value(to) });
	};
	add("title", boardItem.name, story.title);
	if (resolved.stateName !== undefined && resolved.stateName !== null)
		add("status", boardItem.stateName, resolved.stateName);
	if (story.priority !== null) add("priority", boardItem.priority, story.priority);
	if (story.estimate !== null) add("estimate", boardItem.estimate, story.estimate);
	const labelDiff = resolved.labels.length ? labelsChange(boardItem.labels, resolved.labels) : null;
	if (labelDiff) changes.push(labelDiff);
	if (resolved.assigneeId !== undefined && resolved.assigneeId !== null) {
		if (boardItem.assigneeId !== resolved.assigneeId) {
			changes.push({
				field: "assignee",
				from: value(boardItem.assigneeEmail ?? boardItem.assigneeDisplayName),
				to: value(resolved.assigneeDisplay),
			});
		}
	}
	if (resolved.parentIdentifier !== undefined && resolved.parentIdentifier !== null) {
		add("parent", input.boardParentIdentifier, resolved.parentIdentifier);
	}

	const boardBody = canonical(boardItem.description ?? "");
	const fileBody = canonical(input.bodyForWrite);
	const descriptionDiffers = Boolean(input.bodyForWrite) && boardBody !== fileBody;
	let descriptionPreview: string | undefined;
	if (descriptionDiffers) {
		changes.push({ field: "description", from: null, to: null });
		const before = boardBody.split("\n");
		const after = fileBody.split("\n");
		const length = Math.max(before.length, after.length);
		for (let i = 0; i < length; i++) {
			if (before[i] !== after[i]) {
				descriptionPreview = `- ${before[i] ?? ""}\n+ ${after[i] ?? ""}`;
				break;
			}
		}
	}
	return {
		changes,
		descriptionDiffers,
		descriptionPreview,
		hashOnly: Boolean(input.hashMismatch) && changes.length === 0,
	};
}
