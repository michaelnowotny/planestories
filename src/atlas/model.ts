import { splitBody } from "../markdown/criteria.ts";
import { parseEffortDays } from "../markdown/directives.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import type { PlaneClient, PlaneIssueRelations } from "../plane/client.ts";
import type { ProjectIndex } from "../plane/issues.ts";
import { criterionIndex, descriptionHasCriteria, isCriterionChild } from "../sync/board-story.ts";
import type { UserStory } from "../types.ts";
import { assessQuality, type QualityAssessment } from "./quality.ts";

export type AtlasNodeKind = "epic" | "story";

/** A dependency edge between two nodes (referenced by node id). */
export type AtlasEdgeType = "blocks" | "relates";
export interface AtlasEdge {
	/** For "blocks": the blocker. For "relates": one (undirected) endpoint. */
	source: string;
	/** For "blocks": the thing being blocked. For "relates": the other endpoint. */
	target: string;
	type: AtlasEdgeType;
}
export type StatusGroup =
	| "backlog"
	| "unstarted"
	| "started"
	| "completed"
	| "cancelled"
	| "unknown";

export interface AtlasCriterion {
	text: string;
	checked: boolean;
}

export interface AtlasNode {
	/** Stable id used only for client-side expand/collapse state. */
	id: string;
	kind: AtlasNodeKind;
	title: string;
	/** Human identifier (e.g. "DATA-12"), or null when unlinked. */
	identifier: string | null;
	/** Deep link to the Plane work item, or null. */
	url: string | null;
	status: string | null;
	statusGroup: StatusGroup;
	labels: string[];
	assignee: string | null;
	/**
	 * Dev-day effort from the `**Effort:** N dev-days` body line (null when
	 * absent — never coerced to 0; unknown renders as the default mid-weight).
	 * Drives planet SIZE (log scale) + the epic dossier's total/remaining.
	 */
	effortDays: number | null;
	/** Plane priority ("urgent" | "high" | "medium" | "low"), null when unset. */
	priority: string | null;
	/** Acceptance criteria (stories only). */
	criteria: AtlasCriterion[];
	/** Light spec-quality assessment (stories only). */
	quality: QualityAssessment | null;
	children: AtlasNode[];
}

/**
 * How much of a graph's dependency structure was actually observed.
 *
 * THREE states, not two. A boolean (or `failures === 0`) conflates "we swept and
 * every lookup succeeded" with "we never swept at all", and the second one then
 * renders as a finding about the board — *nothing blocks anything else* — which
 * is absence of observation published as observed absence.
 *
 * It lives beside `AtlasGraph` because it is a property OF a graph: every
 * consumer that reads edges needs it, and putting it in the CLI layer would mean
 * the renderer importing from `cli/`.
 */
export type DependencyCoverage =
	| { kind: "complete" }
	/** The sweep ran; this many lookups failed even after the paced retry pass. */
	| { kind: "partial"; failures: number }
	/** No sweep was attempted (`--no-dependencies`). The graph has NO edges. */
	| { kind: "skipped" };

export interface AtlasGraph {
	project: string;
	source: "file" | "board";
	/** Top-level nodes under the project: epics + standalone stories. */
	nodes: AtlasNode[];
	/** Dependency edges between nodes (blocked_by/blocks -> "blocks"; relates_to -> "relates"). */
	edges: AtlasEdge[];
	/** Distinct label names (for filter chips). */
	labels: string[];
	/** Distinct assignee names/emails present (for filter chips), sorted. */
	assignees: string[];
	/** Distinct status names present. */
	statuses: string[];
	counts: { epics: number; stories: number; criteria: number; flagged: number; edges: number };
}

/**
 * Build a deduped edge list from per-node dependency identifiers. `resolve` maps a
 * dependency identifier/uuid to a node id (or null when it isn't a node in this
 * graph — a dangling/cross-project reference, which is skipped). A "blocks" edge
 * always points blocker -> blocked; "relates" is undirected and deduped by the
 * unordered pair. Self-edges are dropped.
 */
function buildEdges(
	specs: Array<{ id: string; blockedBy: string[]; blocks: string[]; relatesTo: string[] }>,
	resolve: (identifier: string) => string | null,
): AtlasEdge[] {
	const edges: AtlasEdge[] = [];
	const seen = new Set<string>();
	const addBlocks = (blockerId: string, blockedId: string): void => {
		if (blockerId === blockedId) return;
		const key = `b:${blockerId}>${blockedId}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({ source: blockerId, target: blockedId, type: "blocks" });
	};
	const addRelates = (a: string, b: string): void => {
		if (a === b) return;
		const key = `r:${[a, b].sort().join("|")}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({ source: a, target: b, type: "relates" });
	};
	for (const spec of specs) {
		for (const raw of spec.blockedBy) {
			const other = resolve(raw);
			if (other) addBlocks(other, spec.id); // `other` blocks this node
		}
		for (const raw of spec.blocks) {
			const other = resolve(raw);
			if (other) addBlocks(spec.id, other); // this node blocks `other`
		}
		for (const raw of spec.relatesTo) {
			const other = resolve(raw);
			if (other) addRelates(spec.id, other);
		}
	}
	return edges;
}

/** Map a free-text status name to a coarse group (used for the file source, which has no group). */
export function statusGroupFromName(name: string | null): StatusGroup {
	if (!name) return "unknown";
	const n = name.toLowerCase();
	if (/\b(done|complete|completed|closed|shipped|merged|resolved)\b/.test(n)) return "completed";
	if (/\b(cancel|cancelled|canceled|won'?t|wont|abandoned|duplicate|invalid)\b/.test(n)) {
		return "cancelled";
	}
	if (/\b(progress|in progress|doing|active|started|review|testing|qa)\b/.test(n)) return "started";
	if (/\b(todo|to do|ready|unstarted|planned|next)\b/.test(n)) return "unstarted";
	if (/\b(backlog|icebox|triage|new)\b/.test(n)) return "backlog";
	return "unknown";
}

let counter = 0;
function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

interface RawNode {
	key: string;
	parentKey: string | null;
	node: AtlasNode;
}

/** Attach nodes to their parents by key; anything without a resolvable parent is a root. */
function assembleTree(raws: RawNode[]): AtlasNode[] {
	const byKey = new Map<string, RawNode>();
	for (const r of raws) {
		byKey.set(r.key, r);
	}
	const roots: AtlasNode[] = [];
	for (const r of raws) {
		const parent = r.parentKey ? byKey.get(r.parentKey) : undefined;
		if (parent) {
			parent.node.children.push(r.node);
		} else {
			roots.push(r.node);
		}
	}
	return roots;
}

/** Roll up the header metrics + filter vocabularies by walking the assembled tree. */
function summarize(
	project: string,
	source: "file" | "board",
	roots: AtlasNode[],
	edges: AtlasEdge[],
): AtlasGraph {
	const labels = new Set<string>();
	const assignees = new Set<string>();
	const statuses = new Set<string>();
	let epics = 0;
	let stories = 0;
	let criteria = 0;
	let flagged = 0;

	const walk = (node: AtlasNode): void => {
		if (node.kind === "epic") epics += 1;
		else stories += 1;
		for (const l of node.labels) labels.add(l);
		if (node.assignee) assignees.add(node.assignee);
		if (node.status) statuses.add(node.status);
		criteria += node.criteria.length;
		if (node.quality && !node.quality.ok) flagged += 1;
		for (const child of node.children) walk(child);
	};
	for (const root of roots) walk(root);

	return {
		project,
		source,
		nodes: roots,
		edges,
		labels: [...labels].sort(),
		assignees: [...assignees].sort(),
		statuses: [...statuses],
		counts: { epics, stories, criteria, flagged, edges: edges.length },
	};
}

// --- File source -----------------------------------------------------------

/** Build an Atlas graph from one parsed markdown file (offline, no API). */
export function buildAtlasFromFile(fileContent: string, filePath: string): AtlasGraph {
	counter = 0; // deterministic node ids per build (diff-stable output)
	const parsed = parseMarkdownFile(fileContent, filePath);
	const project =
		parsed.frontmatter.project ?? parsed.stories.find((s) => s.project)?.project ?? "Project";

	// Criterion sub-item blocks (kind: criterion) belong to their parent story's AC ring.
	const criterionBlocks = parsed.stories.filter((s) => s.kind === "criterion");
	const criteriaByParent = new Map<string, AtlasCriterion[]>();
	for (const c of criterionBlocks) {
		const parentKey = c.parent;
		if (!parentKey) continue;
		const list = criteriaByParent.get(parentKey) ?? [];
		list.push({ text: c.title, checked: statusGroupFromName(c.status) === "completed" });
		criteriaByParent.set(parentKey, list);
	}

	const issues = parsed.stories.filter((s) => s.kind !== "criterion");
	const epics = classifyFileEpics(parsed.stories);

	const pairs = issues.map((story) => {
		const { narrative, criteria: inlineCriteria } = splitBody(story.body);
		const criteria: AtlasCriterion[] = [
			...inlineCriteria.map((c) => ({ text: c.text, checked: c.checked })),
			...(story.planeIdentifier ? (criteriaByParent.get(story.planeIdentifier) ?? []) : []),
		];
		const isEpic = epics.has(story);
		const key = story.planeIdentifier ?? nextId("f");
		const raw: RawNode = {
			key,
			parentKey: story.parent ?? null,
			node: {
				id: nextId("n"),
				kind: isEpic ? "epic" : "story",
				title: story.title,
				identifier: story.planeIdentifier,
				url: story.planeUrl,
				status: story.status,
				statusGroup: statusGroupFromName(story.status),
				labels: story.labels,
				assignee: story.assignee,
				effortDays: story.effortDays,
				priority: story.priority,
				criteria: isEpic ? [] : criteria,
				quality: isEpic ? null : assessQuality({ criteria, description: narrative }),
				children: [],
			},
		};
		return { story, raw };
	});
	const raws = pairs.map((p) => p.raw);

	// Dependency edges: resolve story identifiers to node ids.
	const idToNode = new Map<string, string>();
	for (const { story, raw } of pairs) {
		if (story.planeIdentifier)
			idToNode.set(story.planeIdentifier.trim().toUpperCase(), raw.node.id);
	}
	const edges = buildEdges(
		pairs.map(({ story, raw }) => ({
			id: raw.node.id,
			blockedBy: story.blockedBy,
			blocks: story.blocks,
			relatesTo: story.relatesTo,
		})),
		(identifier) => idToNode.get(identifier.trim().toUpperCase()) ?? null,
	);

	return summarize(project, "file", assembleTree(raws), edges);
}

/**
 * Classify epics in an offline markdown fileset.
 *
 * This is shared by Atlas and file linting so hierarchy-derived epics cannot be
 * interpreted differently by the two offline views. An exact `Epic` label is
 * retained as a backwards-compatible marker alongside the preferred `kind:
 * epic`; otherwise a criteria-free non-criterion item referenced as the parent
 * of another non-criterion item is an epic.
 */
export function classifyFileEpics(stories: readonly UserStory[]): Set<UserStory> {
	const issues = stories.filter((story) => story.kind !== "criterion");
	const referencedAsParent = new Set(
		issues
			.map((story) => story.parent)
			.filter((identifier): identifier is string => identifier !== null),
	);
	const criterionParents = new Set(
		stories
			.filter((story) => story.kind === "criterion")
			.map((story) => story.parent)
			.filter((identifier): identifier is string => identifier !== null),
	);

	return new Set(
		issues.filter((story) => {
			if (story.kind === "epic" || story.labels.includes("Epic")) {
				return true;
			}
			const identifier = story.planeIdentifier;
			const hasCriteria =
				splitBody(story.body).criteria.length > 0 ||
				(identifier !== null && criterionParents.has(identifier));
			return identifier !== null && !hasCriteria && referencedAsParent.has(identifier);
		}),
	);
}

// --- Board source ----------------------------------------------------------

/**
 * Build an Atlas graph from a live Plane project (via fetchProjectIndex). Pass
 * `relationsById` (work-item id -> its Plane relations, fetched by the caller) to
 * include dependency edges; omit it for a hierarchy-only graph.
 */
export function buildAtlasFromBoard(
	client: PlaneClient,
	projectId: string,
	projectIdentifier: string,
	projectName: string,
	index: ProjectIndex,
	relationsById?: ReadonlyMap<string, PlaneIssueRelations>,
): AtlasGraph {
	counter = 0; // deterministic node ids per build (diff-stable output)
	const raws: RawNode[] = [];
	const itemIdToNode = new Map<string, string>();

	for (const item of index.items) {
		if (isCriterionChild(item)) {
			continue; // criteria are folded into their parent story's AC ring
		}

		const children = index.childrenByParent.get(item.id) ?? [];
		// Description-first (design §2): a default/migrated item carries its criteria
		// in the description task-list — read them from there. Only a legacy parent
		// WITHOUT a description checklist falls back to its `::ac<n>` children (using
		// the full child description, not the 255-truncated name). Keying off "has a
		// description checklist" (not child count) is required because migrate closes
		// but never deletes children.
		const criteria: AtlasCriterion[] = descriptionHasCriteria(item)
			? splitBody(item.description ?? "").criteria
			: children
					.filter(isCriterionChild)
					.sort((a, b) => criterionIndex(a) - criterionIndex(b))
					.map((c) => ({
						text: (c.description?.trim() || c.name).trim(),
						checked: c.stateGroup === "completed",
					}));
		const isEpic = children.some((c) => !isCriterionChild(c));

		const nodeId = nextId("n");
		itemIdToNode.set(item.id, nodeId);
		raws.push({
			key: item.id,
			parentKey: item.parent ?? null,
			node: {
				id: nodeId,
				kind: isEpic ? "epic" : "story",
				title: item.name,
				identifier: `${projectIdentifier}-${item.sequenceId}`,
				url: client.workItemWebUrl(projectId, item.id),
				status: item.stateName ?? null,
				statusGroup: (item.stateGroup as StatusGroup) ?? "unknown",
				labels: item.labels,
				assignee: item.assigneeEmail ?? item.assigneeDisplayName ?? null,
				effortDays: parseEffortDays(item.description ?? ""),
				priority: item.priority ?? null,
				criteria: isEpic ? [] : criteria,
				quality: isEpic ? null : assessQuality({ criteria, description: item.description ?? "" }),
				children: [],
			},
		});
	}

	// Dependency edges from the fetched relations (uuids resolve to node ids).
	const edges = relationsById
		? buildEdges(
				[...relationsById.entries()]
					.filter(([itemId]) => itemIdToNode.has(itemId))
					.map(([itemId, rel]) => ({
						id: itemIdToNode.get(itemId) as string,
						blockedBy: rel.blocked_by ?? [],
						blocks: rel.blocking ?? [],
						relatesTo: rel.relates_to ?? [],
					})),
				(uuid) => itemIdToNode.get(uuid) ?? null,
			)
		: [];

	// Criteria were skipped above, so assembleTree only links non-criterion nodes.
	return summarize(projectName, "board", assembleTree(raws), edges);
}
