import { splitBody } from "../markdown/criteria.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import type { PlaneClient } from "../plane/client.ts";
import type { ProjectIndex } from "../plane/issues.ts";
import { criterionIndex, isCriterionChild } from "../sync/board-story.ts";
import type { UserStory } from "../types.ts";
import { assessQuality, type QualityAssessment } from "./quality.ts";

export type AtlasNodeKind = "epic" | "story";
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
	/** Acceptance criteria (stories only). */
	criteria: AtlasCriterion[];
	/** Light spec-quality assessment (stories only). */
	quality: QualityAssessment | null;
	children: AtlasNode[];
}

export interface AtlasGraph {
	project: string;
	source: "file" | "board";
	/** Top-level nodes under the project: epics + standalone stories. */
	nodes: AtlasNode[];
	/** Distinct label names (for filter chips). */
	labels: string[];
	/** Distinct status names present. */
	statuses: string[];
	counts: { epics: number; stories: number; criteria: number; flagged: number };
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
function summarize(project: string, source: "file" | "board", roots: AtlasNode[]): AtlasGraph {
	const labels = new Set<string>();
	const statuses = new Set<string>();
	let epics = 0;
	let stories = 0;
	let criteria = 0;
	let flagged = 0;

	const walk = (node: AtlasNode): void => {
		if (node.kind === "epic") epics += 1;
		else stories += 1;
		for (const l of node.labels) labels.add(l);
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
		labels: [...labels].sort(),
		statuses: [...statuses],
		counts: { epics, stories, criteria, flagged },
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
	const referencedAsParent = new Set(
		issues.map((s) => s.parent).filter((p): p is string => Boolean(p)),
	);

	const raws: RawNode[] = issues.map((story) => {
		const { narrative, criteria: inlineCriteria } = splitBody(story.body);
		const criteria: AtlasCriterion[] = [
			...inlineCriteria.map((c) => ({ text: c.text, checked: c.checked })),
			...(story.planeIdentifier ? (criteriaByParent.get(story.planeIdentifier) ?? []) : []),
		];
		const isEpic = classifyFileEpic(story, criteria.length, referencedAsParent);
		const key = story.planeIdentifier ?? nextId("f");
		return {
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
				criteria: isEpic ? [] : criteria,
				quality: isEpic ? null : assessQuality({ criteria, description: narrative }),
				children: [],
			},
		};
	});

	return summarize(project, "file", assembleTree(raws));
}

function classifyFileEpic(
	story: UserStory,
	criteriaCount: number,
	referencedAsParent: Set<string>,
): boolean {
	if (story.kind === "epic") return true;
	if (story.labels.includes("Epic")) return true;
	if (
		criteriaCount === 0 &&
		story.planeIdentifier &&
		referencedAsParent.has(story.planeIdentifier)
	) {
		return true;
	}
	return false;
}

// --- Board source ----------------------------------------------------------

/** Build an Atlas graph from a live Plane project (via fetchProjectIndex). */
export function buildAtlasFromBoard(
	client: PlaneClient,
	projectId: string,
	projectIdentifier: string,
	projectName: string,
	index: ProjectIndex,
): AtlasGraph {
	counter = 0; // deterministic node ids per build (diff-stable output)
	const raws: RawNode[] = [];

	for (const item of index.items) {
		if (isCriterionChild(item)) {
			continue; // criteria are folded into their parent story's AC ring
		}

		const children = index.childrenByParent.get(item.id) ?? [];
		const criteria: AtlasCriterion[] = children
			.filter(isCriterionChild)
			.sort((a, b) => criterionIndex(a) - criterionIndex(b))
			.map((c) => ({ text: c.name, checked: c.stateGroup === "completed" }));
		const isEpic = children.some((c) => !isCriterionChild(c));

		raws.push({
			key: item.id,
			parentKey: item.parent ?? null,
			node: {
				id: nextId("n"),
				kind: isEpic ? "epic" : "story",
				title: item.name,
				identifier: `${projectIdentifier}-${item.sequenceId}`,
				url: client.workItemWebUrl(projectId, item.id),
				status: item.stateName ?? null,
				statusGroup: (item.stateGroup as StatusGroup) ?? "unknown",
				labels: item.labels,
				assignee: item.assigneeEmail ?? item.assigneeDisplayName ?? null,
				criteria: isEpic ? [] : criteria,
				quality: isEpic ? null : assessQuality({ criteria, description: item.description ?? "" }),
				children: [],
			},
		});
	}

	// Criteria were skipped above, so assembleTree only links non-criterion nodes.
	return summarize(projectName, "board", assembleTree(raws));
}
