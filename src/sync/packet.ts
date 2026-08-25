import { ConfigError } from "../errors.ts";
import {
	type AcceptanceCriterion,
	classifyAcceptanceCriteriaLines,
	splitBody,
} from "../markdown/criteria.ts";
import { formatDevDays, parseEffortDays } from "../markdown/directives.ts";
import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import { type FetchedWorkItem, fetchProjectIndex, type ProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import { criterionIndex, descriptionHasCriteria, isCriterionChild } from "./board-story.ts";

/**
 * State groups that count as "closed" for dependency sequencing — a dependency in
 * one of these no longer gates work. Mirrors groomer's COMPLETED_GROUPS: a
 * `cancelled` prereq is resolved (won't ever complete), not pending.
 */
const DONE_GROUPS = new Set(["completed", "cancelled"]);

function isDone(item: FetchedWorkItem): boolean {
	return DONE_GROUPS.has(item.stateGroup ?? "");
}

/** A dependency edge resolved to a human identifier + its current board status. */
export interface DependencyRef {
	identifier: string;
	title: string;
	status: string | null;
	/** True when the referenced item is in a closed (completed/cancelled) state group. */
	done: boolean;
	/** True when the relation's target could not be resolved in this project index. */
	unresolved?: boolean;
}

/** One story's implementable brief. */
export interface PacketStory {
	identifier: string;
	title: string;
	status: string | null;
	/** True when this item itself is in a closed (completed/cancelled) state group. */
	done: boolean;
	/** True when this item parents non-criterion children (it is itself an epic). */
	isEpic: boolean;
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
	/**
	 * For an epic, ALL descendant non-criterion items (sub-epics AND their stories),
	 * in tree order — each a full brief. Empty for a story.
	 */
	children: PacketStory[];
}

const PLANNING_REF = /planning\/[A-Za-z0-9._/-]+/g;

export function isEpic(item: FetchedWorkItem, index: ProjectIndex): boolean {
	return (index.childrenByParent.get(item.id) ?? []).some((c) => !isCriterionChild(c));
}

/**
 * All non-criterion descendants of `root` (sub-epics AND their stories), in tree
 * order (each parent immediately before its children; siblings by sequence id).
 * Excludes `root` itself. A `visited` guard makes it safe against a malformed
 * parent cycle.
 */
export function collectDescendants(root: FetchedWorkItem, index: ProjectIndex): FetchedWorkItem[] {
	const out: FetchedWorkItem[] = [];
	const visited = new Set<string>([root.id]);
	const walk = (parent: FetchedWorkItem): void => {
		const kids = (index.childrenByParent.get(parent.id) ?? [])
			.filter((c) => !isCriterionChild(c))
			.sort((a, b) => a.sequenceId - b.sequenceId);
		for (const kid of kids) {
			if (visited.has(kid.id)) {
				continue;
			}
			visited.add(kid.id);
			out.push(kid);
			walk(kid);
		}
	};
	walk(root);
	return out;
}

/**
 * Reconstruct a story's acceptance criteria — description-first (design §2). When
 * the item carries its criteria in the description, that is authoritative; only a
 * legacy parent WITHOUT a description checklist falls back to its `::ac<n>`
 * children (full child description, not the 255-truncated name). Keying off "has a
 * description checklist" (not child count) matters because migrate closes but never
 * deletes children — child-first would show every criterion checked post-migration.
 */
function criteriaForItem(item: FetchedWorkItem, index: ProjectIndex): AcceptanceCriterion[] {
	if (descriptionHasCriteria(item)) {
		return splitBody(item.description ?? "").criteria;
	}
	return (index.childrenByParent.get(item.id) ?? [])
		.filter(isCriterionChild)
		.sort((a, b) => criterionIndex(a) - criterionIndex(b))
		.map((child) => ({
			text: (child.description?.trim() || child.name).trim(),
			checked: child.stateGroup === "completed",
		}));
}

/**
 * The description with ONLY the inline acceptance-criteria checklist removed —
 * text before AND after the AC section is kept. `splitBody(...).narrative` drops
 * everything from the AC heading onward, which would lose e.g. a following
 * `### Implementation notes` from the "self-contained" packet. The AC checklist
 * itself is rendered separately (from sub-items or the inline criteria) with the
 * board's current state, so keeping it here too would duplicate it.
 */
function narrativeWithoutCriteria(body: string): string {
	const lines = body.split("\n");
	const classification = classifyAcceptanceCriteriaLines(lines);
	if (classification.headingIndex === -1) {
		return body.trim();
	}
	return [...lines.slice(0, classification.headingIndex), ...lines.slice(classification.sectionEnd)]
		.join("\n")
		.trim();
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
	const resolved = ids
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
					done: isDone(it),
					sequenceId: it.sequenceId,
				},
			];
		})
		.sort((a, b) => a.sequenceId - b.sequenceId)
		.map(({ sequenceId: _seq, ...ref }) => ref);

	// A relation whose target isn't in this project index (cross-project, deleted,
	// or absent from the list payload) is SURFACED, never silently dropped — hiding
	// a real blocker from an agent brief is worse than a noisy note.
	const unresolved: DependencyRef[] = ids
		.filter((id) => !index.byId.get(id))
		.sort()
		.map((id) => ({
			identifier: "(unresolved)",
			// Full UUID so an agent can re-query it (cross-project / recently-deleted).
			title: `not in project ${projectIdentifier} (${id})`,
			status: null,
			done: false,
			unresolved: true,
		}));

	return [...resolved, ...unresolved];
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
	const narrative = narrativeWithoutCriteria(item.description ?? "");
	const parent = item.parent ? index.byId.get(item.parent) : undefined;
	return {
		identifier: `${projectIdentifier}-${item.sequenceId}`,
		title: item.name,
		status: item.stateName ?? null,
		done: isDone(item),
		isEpic: isEpic(item, index),
		effortDays: parseEffortDays(item.description ?? ""),
		parent: parent
			? { identifier: `${projectIdentifier}-${parent.sequenceId}`, title: parent.name }
			: null,
		narrative,
		criteria: criteriaForItem(item, index),
		blockedBy: dependencyRefs(relations.blocked_by ?? [], index, projectIdentifier),
		blocks: dependencyRefs(relations.blocking ?? [], index, projectIdentifier),
		relatesTo: dependencyRefs(relations.relates_to ?? [], index, projectIdentifier),
		planningRefs: planningRefs(narrative),
		url: client.workItemWebUrl(projectId, item.id),
	};
}

function renderCriteria(criteria: AcceptanceCriterion[]): string[] {
	if (criteria.length === 0) {
		return ["_(none)_"];
	}
	return criteria.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`);
}

/**
 * Render a dependency list. `flagNotDone` is true ONLY for the "Blocked by" set —
 * a hard ordering constraint — so an unfinished prereq gets a `⚠ not done` marker.
 * `blocks`/`relates_to` are not ordering gates, so they carry no such warning (an
 * agent must not read a related open item as a hard stop). An unresolved edge is
 * always flagged so a hidden blocker can't slip through.
 */
function renderDeps(refs: DependencyRef[], flagNotDone: boolean): string[] {
	if (refs.length === 0) {
		return ["- _(none)_"];
	}
	return refs.map((r) => {
		if (r.unresolved) {
			return `- ${r.identifier} — ${r.title} ⚠ unresolved`;
		}
		const status = r.status ? ` [${r.status}]` : "";
		const flag = flagNotDone && !r.done ? " ⚠ not done" : "";
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
	lines.push(...renderDeps(story.blockedBy, true));
	lines.push("");
	lines.push("**Blocks:**");
	lines.push(...renderDeps(story.blocks, false));
	lines.push("");
	lines.push("**Related:**");
	lines.push(...renderDeps(story.relatesTo, false));
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

/** The resolved (real) identifiers of a dependency set, for the machine-readable header. */
function resolvedIds(refs: DependencyRef[]): string[] {
	return refs.filter((r) => !r.unresolved).map((r) => r.identifier);
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
		// Machine-readable id lists carry only RESOLVED identifiers (an "(unresolved)"
		// placeholder isn't a valid id); the unresolved edges still show in the human
		// Dependencies section with a ⚠ marker.
		`blocked_by: [${resolvedIds(root.blockedBy).join(", ")}]`,
		`blocks: [${resolvedIds(root.blocks).join(", ")}]`,
		`relates_to: [${resolvedIds(root.relatesTo).join(", ")}]`,
	];
	if (packet.kind === "epic") {
		header.push(`children: [${packet.children.map((c) => c.identifier).join(", ")}]`);
		// Sum only non-epic descendants' effort (epics carry no work of their own) and
		// format via formatDevDays so 0.1 + 0.2 renders "0.3", not "0.30000000000000004".
		const leaves = packet.children.filter((c) => !c.isEpic);
		const total = leaves.reduce((sum, c) => sum + (c.effortDays ?? 0), 0);
		const missing = leaves.filter((c) => c.effortDays === null).length;
		header.push(`children_effort_days: ${formatDevDays(total)}`);
		// The sum is a LOWER BOUND when some leaf stories have no effort — say so, so a
		// consumer never mistakes a partial estimate for a complete one.
		header.push(`children_effort_missing: ${missing}`);
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
 * (an item that parents non-criterion children): the epic + every descendant's brief (nested epics included).
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
	// A criterion sub-item is not an implementable ticket on its own — packeting it
	// would present a single acceptance criterion as work and mislabel its parent
	// story as an "Epic". Point the caller at the owning story instead.
	if (isCriterionChild(target)) {
		const parent = target.parent ? index.byId.get(target.parent) : undefined;
		const parentHint = parent
			? ` — packet its parent story ${project.identifier}-${parent.sequenceId} instead`
			: "";
		throw new ConfigError(
			`${options.identifier} is an acceptance-criterion sub-item, not an implementable ticket${parentHint}.`,
		);
	}

	const epic = isEpic(target, index);
	// ALL descendant non-criterion items in tree order (DFS), so nested epics'
	// grandchildren are included — a packet for an epic is the whole subtree.
	const children = epic ? collectDescendants(target, index) : [];

	// One relations fetch per item in the packet (root + children), bounded.
	const itemsNeedingRelations = [target, ...children];
	const concurrency = client.concurrency() ?? 6;
	const relationsPairs = await mapWithConcurrency(
		itemsNeedingRelations,
		concurrency,
		async (item) => {
			const relations = await client.getRelations(project.id, item.id);
			return [item.id, relations] as const;
		},
	);
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
