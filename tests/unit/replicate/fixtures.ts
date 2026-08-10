import { computeSnapshotDigest } from "../../../src/replicate/snapshot.ts";
import { type ProjectSnapshot, SNAPSHOT_SCHEMA_VERSION } from "../../../src/replicate/types.ts";

export function sampleSnapshot(): ProjectSnapshot {
	const snapshot: ProjectSnapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		toolVersion: "test",
		takenAt: "2025-01-01T00:00:00Z",
		source: {
			baseUrl: "https://source.example.test",
			workspaceSlug: "source",
			projectId: "source-project",
			dialect: "issues",
			archivedInventory: "listed",
		},
		project: { name: "Source", identifier: "SRC", description: "project description" },
		states: [
			{
				id: "state-backlog",
				name: "Backlog",
				group: "backlog",
				color: "#111111",
				description: "queue",
				isDefault: true,
			},
			{
				id: "state-review",
				name: "Review",
				group: "started",
				color: "#222222",
				description: "reviewing",
				isDefault: false,
			},
		],
		labels: [
			{ id: "label-parent", name: "Area", color: "#aaaaaa", description: "", parentId: null },
			{
				id: "label-child",
				name: "Backend",
				color: "#bbbbbb",
				description: "child",
				parentId: "label-parent",
			},
		],
		members: [
			{ id: "source-mapped", email: "mapped@example.test", displayName: "Mapped Source" },
			{ id: "source-missing", email: "missing@example.test", displayName: "Missing Source" },
		],
		items: [
			item("source-1", 1, { labelIds: ["label-child"], createdBy: "source-mapped" }),
			item("source-3", 3, {
				parentId: "source-1",
				stateId: "state-review",
				assigneeIds: ["source-mapped"],
			}),
			item("source-5", 5, { archived: true, createdBy: "source-missing" }),
			item("source-6", 6),
			item("source-7", 7),
		],
		relations: {
			"source-1": { blocked_by: ["source-3"], start_before: ["source-5"] },
			"source-3": { relates_to: ["source-5"] },
		},
		comments: {
			"source-1": [
				{
					id: "comment-native",
					commentHtml: "<p>native</p>",
					createdAt: "2024-01-01T00:00:00Z",
					createdBy: "source-mapped",
				},
			],
			"source-3": [
				{
					id: "comment-footer",
					commentHtml: "<p>footer</p>",
					createdAt: "2024-01-02T00:00:00Z",
					createdBy: "source-missing",
				},
			],
		},
		sequence: { max: 7, present: [1, 3, 5, 6, 7], gaps: [2, 4] },
		digest: "",
	};
	snapshot.digest = computeSnapshotDigest(snapshot);
	return snapshot;
}

function item(
	id: string,
	sequenceId: number,
	overrides: Partial<ProjectSnapshot["items"][number]> = {},
): ProjectSnapshot["items"][number] {
	return {
		id,
		sequenceId,
		name: `Item ${sequenceId}`,
		descriptionHtml: `<p>Description ${sequenceId}</p>`,
		priority: "medium",
		point: sequenceId,
		stateId: "state-backlog",
		parentId: null,
		labelIds: [],
		assigneeIds: [],
		createdAt: "2024-01-01T00:00:00Z",
		updatedAt: "2024-02-01T00:00:00Z",
		createdBy: "source-mapped",
		startDate: null,
		targetDate: null,
		completedAt: null,
		externalSource: "source-system",
		externalId: `external-${sequenceId}`,
		archived: false,
		...overrides,
	};
}
