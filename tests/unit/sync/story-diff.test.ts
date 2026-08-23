import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../../../src/markdown/html.ts";
import type { FetchedWorkItem } from "../../../src/plane/issues.ts";
import { diffStoryAgainstBoard } from "../../../src/sync/story-diff.ts";
import type { UserStory } from "../../../src/types.ts";

const story: UserStory = {
	title: "New",
	planeId: "one",
	planeIdentifier: "DATA-1",
	planeUrl: null,
	planeHash: "old",
	priority: "high",
	labels: ["new"],
	estimate: 3,
	effortDays: null,
	assignee: "new@example.com",
	status: "In Progress",
	body: "Hello\n\n- [ ] task",
	project: "Data",
	parent: "DATA-9",
	blockedBy: [],
	blocks: [],
	relatesTo: [],
	kind: "story",
	comment: null,
};
const board: FetchedWorkItem = {
	id: "one",
	sequenceId: 1,
	name: "Old",
	createdAt: null,
	updatedAt: null,
	description: "Goodbye",
	priority: "low",
	estimate: 1,
	stateName: "Backlog",
	assigneeEmail: "old@example.com",
	assigneeDisplayName: "Old",
	assigneeId: "member-old",
	labels: ["old"],
	externalSource: undefined,
	externalId: undefined,
	parent: "parent",
	stateGroup: "backlog",
};

describe("diffStoryAgainstBoard", () => {
	test("reports changed fields in stable order and one description pair", () => {
		const result = diffStoryAgainstBoard({
			story,
			bodyForWrite: story.body,
			boardItem: board,
			boardParentIdentifier: "DATA-8",
			resolved: {
				stateName: story.status,
				labels: story.labels,
				assigneeId: "member-new",
				assigneeDisplay: story.assignee,
				parentIdentifier: story.parent,
			},
			hashMismatch: true,
		});
		expect(result.changes.map((change) => change.field)).toEqual([
			"title",
			"status",
			"priority",
			"estimate",
			"labels",
			"assignee",
			"parent",
			"description",
		]);
		expect(result.descriptionPreview).toBe("- Goodbye\n+ Hello");
	});

	test("canonical markdown prevents Plane HTML formatting phantoms", () => {
		const same = {
			...story,
			title: "New",
			priority: null,
			estimate: null,
			labels: [],
			assignee: null,
			status: null,
			parent: null,
			body: "- [ ] task",
		};
		const planeHtml =
			'<ul data-type="taskList" class="tiptap-list"><li data-type="taskItem" data-checked="false" class="task"><label><input type="checkbox"><span></span></label><div><p>task</p></div></li></ul>';
		const result = diffStoryAgainstBoard({
			story: same,
			bodyForWrite: same.body,
			boardItem: { ...board, name: "New", description: htmlToMarkdown(planeHtml) },
			resolved: { labels: [] },
			hashMismatch: true,
		});
		expect(result.descriptionDiffers).toBe(false);
		expect(result.hashOnly).toBe(true);
	});
});
