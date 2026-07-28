import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/errors.ts";
import type { PlaneIssueRelations } from "../../../src/plane/client.ts";
import type { FetchedWorkItem, ProjectIndex } from "../../../src/plane/issues.ts";
import {
	buildPacketStory,
	generatePacket,
	renderPacketMarkdown,
} from "../../../src/sync/packet.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

function item(
	partial: Partial<FetchedWorkItem> & { id: string; sequenceId: number },
): FetchedWorkItem {
	return {
		name: `Item ${partial.sequenceId}`,
		description: undefined,
		priority: undefined,
		estimate: undefined,
		stateName: undefined,
		assigneeEmail: undefined,
		assigneeDisplayName: undefined,
		labels: [],
		externalSource: undefined,
		externalId: undefined,
		parent: undefined,
		stateGroup: undefined,
		...partial,
	};
}

function indexOf(items: FetchedWorkItem[], projectIdentifier: string): ProjectIndex {
	const byId = new Map<string, FetchedWorkItem>();
	const byIdentifier = new Map<string, FetchedWorkItem>();
	const byNormalizedTitle = new Map<string, FetchedWorkItem[]>();
	const childrenByParent = new Map<string, FetchedWorkItem[]>();
	for (const it of items) {
		byId.set(it.id, it);
		byIdentifier.set(`${projectIdentifier}-${it.sequenceId}`, it);
		if (it.parent) {
			const kids = childrenByParent.get(it.parent) ?? [];
			kids.push(it);
			childrenByParent.set(it.parent, kids);
		}
	}
	return { items, byId, byIdentifier, byNormalizedTitle, childrenByParent };
}

function relations(partial: Partial<PlaneIssueRelations>): PlaneIssueRelations {
	return {
		blocking: [],
		blocked_by: [],
		relates_to: [],
		duplicate: [],
		start_before: [],
		start_after: [],
		finish_before: [],
		finish_after: [],
		...partial,
	};
}

describe("buildPacketStory + renderPacketMarkdown (pure)", () => {
	const { client } = makeFakeClient();

	test("builds a story brief with effort, parent, criteria, and dependency status", () => {
		const blocker = item({
			id: "wi-40",
			sequenceId: 40,
			name: "Prereq",
			stateName: "Backlog",
			stateGroup: "backlog",
		});
		const epic = item({ id: "wi-1", sequenceId: 1, name: "Widget epic" });
		const target = item({
			id: "wi-50",
			sequenceId: 50,
			name: "Implement widget",
			parent: "wi-1",
			stateName: "In Progress",
			stateGroup: "started",
			description: [
				"Do the widget work per planning/329-serving-tier.md.",
				"",
				"**Effort:** 2.5 dev-days",
				"",
				"### Acceptance Criteria",
				"- [ ] renders",
				"- [x] clickable",
			].join("\n"),
		});
		const index = indexOf([blocker, epic, target], "DATA");

		const story = buildPacketStory(
			client,
			target,
			index,
			"proj-uuid",
			"DATA",
			relations({ blocked_by: ["wi-40"] }),
		);

		expect(story.identifier).toBe("DATA-50");
		expect(story.effortDays).toBe(2.5);
		expect(story.parent).toEqual({ identifier: "DATA-1", title: "Widget epic" });
		expect(story.criteria).toEqual([
			{ text: "renders", checked: false },
			{ text: "clickable", checked: true },
		]);
		expect(story.blockedBy).toEqual([
			{ identifier: "DATA-40", title: "Prereq", status: "Backlog", done: false },
		]);
		expect(story.planningRefs).toContain("planning/329-serving-tier.md");

		const md = renderPacketMarkdown({ kind: "story", root: story, children: [] });
		expect(md).toContain("packet: DATA-50");
		expect(md).toContain("blocked_by: [DATA-40]");
		expect(md).toContain("**Effort:** 2.5 dev-days");
		expect(md).toContain("DATA-40 — Prereq [Backlog] ⚠ not done");
		expect(md).toContain("- [x] clickable");
		expect(md).toContain("planning/329-serving-tier.md");
	});

	test("reconstructs criteria from criterion sub-items when present (board state)", () => {
		const target = item({
			id: "wi-9",
			sequenceId: 9,
			name: "Has sub-item criteria",
			description: "Narrative only.",
		});
		const c0 = item({
			id: "wi-c0",
			sequenceId: 10,
			name: "first",
			parent: "wi-9",
			externalId: "x::ac0",
			stateGroup: "completed",
		});
		const c1 = item({
			id: "wi-c1",
			sequenceId: 11,
			name: "second",
			parent: "wi-9",
			externalId: "x::ac1",
			stateGroup: "backlog",
		});
		const index = indexOf([target, c0, c1], "DATA");
		const story = buildPacketStory(client, target, index, "p", "DATA", relations({}));
		expect(story.criteria).toEqual([
			{ text: "first", checked: true },
			{ text: "second", checked: false },
		]);
	});
});

const PROJECT_UUID = "aaaaaaaa-1111-2222-3333-444444444444";

const config: ResolvedConfig = {
	apiKey: "k",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Data Platform",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
};

function epicBoard(): FakeData {
	return {
		projects: [{ id: PROJECT_UUID, name: "Data Platform", identifier: "DATA" }],
		workItems: {
			[PROJECT_UUID]: [
				{
					id: "wi-epic",
					sequence_id: 1,
					name: "Widget epic",
					state: { id: "s", name: "In Progress", group: "started" },
				},
				{
					id: "wi-a",
					sequence_id: 50,
					name: "Child A",
					parent: "wi-epic",
					description_html: "<p><strong>Effort:</strong> 2 dev-days</p>",
					state: { id: "s2", name: "Done", group: "completed" },
				},
				{
					id: "wi-b",
					sequence_id: 51,
					name: "Child B",
					parent: "wi-epic",
					description_html: "<p><strong>Effort:</strong> 1.5 dev-days</p>",
					state: { id: "s3", name: "Backlog", group: "backlog" },
				},
			],
		},
	};
}

describe("generatePacket (board wrapper)", () => {
	test("an epic packet includes each child and sums children effort", async () => {
		const { client } = makeFakeClient(epicBoard());
		const { markdown, packet } = await generatePacket(client, { config, identifier: "DATA-1" });

		expect(packet.kind).toBe("epic");
		expect(packet.children.map((c) => c.identifier)).toEqual(["DATA-50", "DATA-51"]);
		expect(markdown).toContain("packet: DATA-1");
		expect(markdown).toContain("children: [DATA-50, DATA-51]");
		expect(markdown).toContain("children_effort_days: 3.5");
		expect(markdown).toContain("## Children (2)");
		expect(markdown).toContain("DATA-50 — Child A");
		expect(markdown).toContain("DATA-51 — Child B");
	});

	test("a lowercase identifier resolves", async () => {
		const { client } = makeFakeClient(epicBoard());
		const { packet } = await generatePacket(client, { config, identifier: "data-50" });
		expect(packet.kind).toBe("story");
		expect(packet.root.identifier).toBe("DATA-50");
	});

	test("an unknown identifier is a clear error, not a crash", async () => {
		const { client } = makeFakeClient(epicBoard());
		await expect(generatePacket(client, { config, identifier: "DATA-999" })).rejects.toBeInstanceOf(
			ConfigError,
		);
	});
});
