import { ConfigError } from "../errors.ts";
import { type AcceptanceCriterion, splitBody } from "../markdown/criteria.ts";
import { parseEffortDays } from "../markdown/directives.ts";
import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import { type FetchedWorkItem, fetchProjectIndex, type ProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import { criterionIndex, isCriterionChild } from "./board-story.ts";

/** A dependency edge resolved to a human identifier + its current board status. */
export interface DependencyRef {
	identifier: string;
	title: string;
	status: string | null;
	/** True when the referenced item is in a completed state group. */
	done: boolean;
}

/** One story's implementable brief. */
export interface PacketStory {
	identifier: string;
	title: string;
	status: string | null;
	/** True when this item itself is in a completed state group. */
	done: boolean;
	effortDays: number | null;
	parent: { identifier: string; title: string } | null;
	narrative: string;
	criteria: AcceptanceCriterion[];
	blockedBy: DependencyRef[];
	blocks: DependencyRef[];
	relatesTo: DependencyRef[];
	/** `planning/...` references found in the narrative. */
	planningRefs: string[];
	url: string;
}

export interface Packet {
	kind: "epic" | "story";
	root: PacketStory;
	/** For an epic, its non-criterion children (each a full brief). Empty for a story. */
	children: PacketStory[];
}

const PLANNING_REF = /planning\/[A-Za-z0-9._/-]+/g;

function isEpic(item: FetchedWorkItem, index: ProjectIndex): boolean {
	return (index.childrenByParent.get(item.id) ?? []).some((c) => !isCriterionChild(c));
}

/** Reconstruct a story's acceptance criteria — from criterion sub-items if present, else inline. */
function criteriaForItem(item: FetchedWorkItem, index: ProjectIndex): AcceptanceCriterion[] {
	const children = (index.childrenByParent.get(item.id) ?? [])
		.filter(isCriterionChild)
		.sort((a, b) => criterionIndex(a) - criterionIndex(b));
	if (children.length > 0) {
		return children.map((child) => ({
			text: child.name,
			checked: child.stateGroup === "completed",
		}));
	}
	return splitBody(item.description ?? "").criteria;
}

function planningRefs(narrative: string): string[] {
	// Strip trailing sentence punctuation the greedy char-class would otherwise
	// swallow (e.g. "...planning/329-x.md." -> "planning/329-x.md").
	const refs = (narrative.match(PLANNING_REF) ?? []).map((r) => r.replace(/[.,;:)\]}'"]+$/, ""));
	return [...new Set(refs)];
}

function dependencyRefs(
	ids: string[],
	index: ProjectIndex,
	projectIdentifier: string,
): DependencyRef[] {
	return ids
		.flatMap((id) => {
			const it = index.byId.get(id);
			if (!it) {
				return [];
			}
			return [
				{
					identifier: `${projectIdentifier}-${it.sequenceId}`,
					title: it.name,
					status: it.stateName ?? null,
					done: it.stateGroup === "completed",
					sequenceId: it.sequenceId,
				},
			];
		})
		.sort((a, b) => a.sequenceId - b.sequenceId)
		.map(({ sequenceId: _seq, ...ref }) => ref);
}

/**
 * Build one story's brief from the fetched index + its relations. Pure — all
 * network reads happened already (index + relations). `relations` is that item's
 * Plane relation set; dependency STATUS comes from the index.
 */
export function buildPacketStory(
	client: PlaneClient,
	item: FetchedWorkItem,
	index: ProjectIndex,
	projectId: string,
	projectIdentifier: string,
	relations: PlaneIssueRelations,
): PacketStory {
	const split = splitBody(item.description ?? "");
	const parent = item.parent ? index.byId.get(item.parent) : undefined;
	return {
		identifier: `${projectIdentifier}-${item.sequenceId}`,
		title: item.name,
		status: item.stateName ?? null,
		done: item.stateGroup === "completed",
		effortDays: parseEffortDays(item.description ?? ""),
		parent: parent
			? { identifier: `${projectIdentifier}-${parent.sequenceId}`, title: parent.name }
			: null,
		narrative: split.narrative,
		criteria: criteriaForItem(item, index),
		blockedBy: dependencyRefs(relations.blocked_by ?? [], index, projectIdentifier),
		blocks: dependencyRefs(relations.blocking ?? [], index, projectIdentifier),
		relatesTo: dependencyRefs(relations.relates_to ?? [], index, projectIdentifier),
		planningRefs: planningRefs(split.narrative),
		url: client.workItemWebUrl(projectId, item.id),
	};
}

function renderCriteria(criteria: AcceptanceCriterion[]): string[] {
	if (criteria.length === 0) {
		return ["_(none)_"];
	}
	return criteria.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`);
}

function renderDeps(refs: DependencyRef[]): string[] {
	if (refs.length === 0) {
		return ["- _(none)_"];
	}
	return refs.map((r) => {
		const status = r.status ? ` [${r.status}]` : "";
		const flag = r.done ? "" : " ⚠ not done";
		return `- ${r.identifier} — ${r.title}${status}${flag}`;
	});
}

function renderStory(story: PacketStory, headingLevel: number): string[] {
	const h = "#".repeat(headingLevel);
	const lines: string[] = [];
	lines.push(`${h} ${story.identifier} — ${story.title}`);
	lines.push("");
	const meta = [
		`**Status:** ${story.status ?? "unknown"}`,
		`**Effort:** ${story.effortDays === null ? "unset" : `${story.effortDays} dev-days`}`,
		story.parent ? `**Epic:** ${story.parent.identifier} (${story.parent.title})` : null,
	]
		.filter((x): x is string => x !== null)
		.join(" · ");
	lines.push(meta);
	lines.push("");
	lines.push(`${h}# Description`);
	lines.push("");
	lines.push(story.narrative.trim().length > 0 ? story.narrative.trim() : "_(no description)_");
	lines.push("");
	lines.push(`${h}# Acceptance criteria`);
	lines.push("");
	lines.push(...renderCriteria(story.criteria));
	lines.push("");
	lines.push(`${h}# Dependencies`);
	lines.push("");
	lines.push("**Blocked by** (must be done first):");
	lines.push(...renderDeps(story.blockedBy));
	lines.push("");
	lines.push("**Blocks:**");
	lines.push(...renderDeps(story.blocks));
	lines.push("");
	lines.push("**Related:**");
	lines.push(...renderDeps(story.relatesTo));
	lines.push("");
	if (story.planningRefs.length > 0) {
		lines.push(`${h}# Planning references`);
		lines.push("");
		lines.push(...story.planningRefs.map((r) => `- ${r}`));
		lines.push("");
	}
	lines.push(`_Source: ${story.url}_`);
	return lines;
}

/** Render a packet to a self-contained markdown brief with a machine-readable header. */
export function renderPacketMarkdown(packet: Packet): string {
	const root = packet.root;
	const header: string[] = [
		"---",
		`packet: ${root.identifier}`,
		`kind: ${packet.kind}`,
		`title: ${JSON.stringify(root.title)}`,
		`status: ${JSON.stringify(root.status ?? "unknown")}`,
		`effort_days: ${root.effortDays === null ? "null" : root.effortDays}`,
		root.parent ? `parent: ${root.parent.identifier}` : "parent: null",
		`blocked_by: [${root.blockedBy.map((d) => d.identifier).join(", ")}]`,
		`blocks: [${root.blocks.map((d) => d.identifier).join(", ")}]`,
		`relates_to: [${root.relatesTo.map((d) => d.identifier).join(", ")}]`,
	];
	if (packet.kind === "epic") {
		header.push(`children: [${packet.children.map((c) => c.identifier).join(", ")}]`);
		const total = packet.children.reduce((sum, c) => sum + (c.effortDays ?? 0), 0);
		header.push(`children_effort_days: ${total}`);
	}
	header.push(`url: ${root.url}`);
	header.push("generated_by: planestories");
	header.push("---");

	const body: string[] = ["", ...renderStory(root, 1)];

	if (packet.kind === "epic" && packet.children.length > 0) {
		body.push("");
		body.push("---");
		body.push("");
		body.push(`## Children (${packet.children.length})`);
		for (const child of packet.children) {
			body.push("");
			body.push(...renderStory(child, 3));
		}
	}

	return `${[...header, ...body].join("\n")}\n`;
}

export interface PacketOptions {
	config: ResolvedConfig;
	/** The Plane identifier of the target work item (e.g. DATA-123). */
	identifier: string;
	project?: string;
}

/**
 * Build a self-contained implementable brief for a coding agent from a board
 * ticket. For a story: its description, acceptance criteria (board state),
 * dependencies WITH their current status, effort, and parent epic. For an epic
 * (an item that parents non-criterion children): the epic + every child's brief.
 * Read-only.
 */
export async function generatePacket(
	client: PlaneClient,
	options: PacketOptions,
): Promise<{ markdown: string; packet: Packet }> {
	const resolver = new Resolver(client);
	const projectName = options.project ?? options.config.defaultProject;
	if (!projectName) {
		throw new ConfigError(
			"No project specified for packet. Provide --project or set defaultProject in config.",
		);
	}
	const project = await resolver.resolveProject(projectName);
	const index = await fetchProjectIndex(client, project.id, project.identifier);

	const target = index.byIdentifier.get(options.identifier.trim().toUpperCase());
	if (!target) {
		throw new ConfigError(
			`Work item ${options.identifier} not found in project ${project.identifier}.`,
		);
	}

	const epic = isEpic(target, index);
	const children = epic
		? (index.childrenByParent.get(target.id) ?? [])
				.filter((c) => !isCriterionChild(c))
				.sort((a, b) => a.sequenceId - b.sequenceId)
		: [];

	// One relations fetch per item in the packet (root + children), bounded.
	const itemsNeedingRelations = [target, ...children];
	const relationsPairs = await mapWithConcurrency(itemsNeedingRelations, 6, async (item) => {
		const relations = await client.getRelations(project.id, item.id);
		return [item.id, relations] as const;
	});
	const relationsById = new Map<string, PlaneIssueRelations>(relationsPairs);

	const emptyRelations: PlaneIssueRelations = {
		blocking: [],
		blocked_by: [],
		relates_to: [],
		duplicate: [],
		start_before: [],
		start_after: [],
		finish_before: [],
		finish_after: [],
	};
	const build = (item: FetchedWorkItem): PacketStory =>
		buildPacketStory(
			client,
			item,
			index,
			project.id,
			project.identifier,
			relationsById.get(item.id) ?? emptyRelations,
		);

	const packet: Packet = {
		kind: epic ? "epic" : "story",
		root: build(target),
		children: children.map(build),
	};

	return { markdown: renderPacketMarkdown(packet), packet };
}
