import type { AtlasGraph, AtlasNode } from "../atlas/model.ts";

/**
 * Critical-path analysis over the dependency graph.
 *
 * The question it answers is "what is the FLOOR on finishing this, and which
 * item is holding it?" — the thing a dependency graph exists to reveal and that
 * no amount of staring at a board tells you.
 *
 * Four decisions carry the honesty of the result:
 *
 * 1. UNESTIMATED WORK MAKES THE TOTAL A LOWER BOUND. An item with no
 *    `**Effort:**` line contributes 0 to the arithmetic, which would otherwise
 *    be exactly the coercion the house rules ban. So the result carries
 *    `unestimatedOnChain` and `isLowerBound`, and no formatter may print the
 *    number without them. "14 days" and "at least 14 days, 6 items unestimated"
 *    are different claims.
 * 2. A CYCLE MAKES THE ANSWER UNDEFINED. Longest-path has no meaning on a
 *    cycle, so we detect and REFUSE rather than break the cycle arbitrarily and
 *    return a confident number. This is not hypothetical: a relation-sync defect
 *    put a real two-node cycle on the production board (HANDOFF §9.5e).
 * 3. FINISHED WORK IS FREE. Completed/cancelled items contribute 0 duration:
 *    the question is time REMAINING, and a done blocker blocks nothing. They
 *    stay in the graph because their edges still order the work behind them.
 * 4. EPICS ARE CONTAINERS, NOT WORK. Only leaves carry duration; counting an
 *    epic and its children would double-count the same days.
 */

export interface CriticalPathNode {
	identifier: string | null;
	title: string;
	/** Null when the story carries no `**Effort:**` line — never coerced. */
	effortDays: number | null;
	status: string | null;
	/** True when completed/cancelled, i.e. contributing zero remaining time. */
	done: boolean;
	earliestStart: number;
	earliestFinish: number;
}

export interface CriticalPathResult {
	/** The longest dependency chain, in order. Empty when nothing is connected. */
	chain: CriticalPathNode[];
	/** Summed effort along the chain. A LOWER BOUND when `isLowerBound`. */
	totalDays: number;
	/** Chain items with no estimate. Non-zero ⇒ the total understates the truth. */
	unestimatedOnChain: number;
	isLowerBound: boolean;
	/** Slack in days per identifier: how long it can slip without moving the end. */
	slackByIdentifier: Record<string, number>;
	/**
	 * The single item whose completion shortens the floor most, with the days it
	 * would save. Null when nothing is on a chain or no item has an estimate.
	 */
	biggestLever: { identifier: string; title: string; daysSaved: number } | null;
	/** Leaves considered (excludes epics). */
	consideredLeaves: number;
	/** Leaves already finished, contributing zero duration. */
	doneLeaves: number;
	/** Leaves with at least one dependency edge. The rest cannot constrain anything. */
	connectedLeaves: number;
	/**
	 * Dependency cycles, as identifier lists. NON-EMPTY MEANS THE RESULT IS NOT
	 * COMPUTED — every other field is at its empty value and must not be read as
	 * "no dependencies".
	 */
	cycles: string[][];
}

interface Leaf {
	node: AtlasNode;
	duration: number;
	done: boolean;
}

/** Flatten to leaves — epics are containers, so only leaves carry duration. */
function collectLeaves(nodes: AtlasNode[], into: Map<string, Leaf>): void {
	for (const node of nodes) {
		if (node.kind === "epic" || (node.children?.length ?? 0) > 0) {
			collectLeaves(node.children ?? [], into);
			continue;
		}
		const done = node.statusGroup === "completed" || node.statusGroup === "cancelled";
		into.set(node.id, {
			node,
			// Finished work is free; unestimated work contributes 0 to the arithmetic
			// and is COUNTED so the caller can label the total a lower bound.
			duration: done ? 0 : (node.effortDays ?? 0),
			done,
		});
	}
}

/** Depth-first cycle detection over `blocks` edges. Returns identifier cycles. */
function findCycles(
	ids: string[],
	successors: Map<string, string[]>,
	label: (id: string) => string,
): string[][] {
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const colour = new Map<string, number>(ids.map((id) => [id, WHITE]));
	const stack: string[] = [];
	const cycles: string[][] = [];
	const seen = new Set<string>();

	const visit = (id: string): void => {
		colour.set(id, GREY);
		stack.push(id);
		for (const next of successors.get(id) ?? []) {
			const state = colour.get(next);
			if (state === GREY) {
				const at = stack.indexOf(next);
				const cycle = [...stack.slice(at), next].map(label);
				// Rotation-insensitive key so one cycle is reported once.
				const key = [...cycle].sort().join("|");
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push(cycle);
				}
			} else if (state === WHITE) {
				visit(next);
			}
		}
		stack.pop();
		colour.set(id, BLACK);
	};

	for (const id of ids) {
		if (colour.get(id) === WHITE) visit(id);
	}
	return cycles;
}

/**
 * Compute the critical path of a graph's `blocks` edges.
 *
 * Pure: takes the same `AtlasGraph` the cockpit renders and the `--json` output
 * emits, so a caller can compute this from a live board OR from any snapshot
 * without a second data path.
 */
export function computeCriticalPath(graph: AtlasGraph): CriticalPathResult {
	const leaves = new Map<string, Leaf>();
	collectLeaves(graph.nodes, leaves);

	const empty = (cycles: string[][]): CriticalPathResult => ({
		chain: [],
		totalDays: 0,
		unestimatedOnChain: 0,
		isLowerBound: false,
		slackByIdentifier: {},
		biggestLever: null,
		consideredLeaves: leaves.size,
		doneLeaves: [...leaves.values()].filter((l) => l.done).length,
		connectedLeaves: 0,
		cycles,
	});

	// "blocks" edges only: source must finish before target may start. `relates`
	// carries no ordering, so including it would invent a constraint.
	const successors = new Map<string, string[]>();
	const predecessors = new Map<string, string[]>();
	const connected = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.type !== "blocks") continue;
		if (!leaves.has(edge.source) || !leaves.has(edge.target)) continue;
		successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target]);
		predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge.source]);
		connected.add(edge.source);
		connected.add(edge.target);
	}

	const ids = [...leaves.keys()];
	const label = (id: string) => leaves.get(id)?.node.identifier ?? leaves.get(id)?.node.title ?? id;

	const cycles = findCycles(ids, successors, label);
	if (cycles.length > 0) {
		// Refuse. A longest path through a cycle is not a longer estimate, it is a
		// meaningless one, and a confident number here would be acted upon.
		return empty(cycles);
	}
	if (connected.size === 0) return empty([]);

	// Topological order (Kahn). Safe now that cycles are excluded.
	const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
	for (const [, targets] of successors) {
		for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
	}
	const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		order.push(id);
		for (const next of successors.get(id) ?? []) {
			const remaining = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) queue.push(next);
		}
	}

	// Forward pass: earliest start/finish, remembering the predecessor that set it
	// so the chain can be walked back without recomputing.
	const earliestStart = new Map<string, number>();
	const earliestFinish = new Map<string, number>();
	const cameFrom = new Map<string, string | null>();
	for (const id of order) {
		let start = 0;
		let from: string | null = null;
		for (const pred of predecessors.get(id) ?? []) {
			const finish = earliestFinish.get(pred) ?? 0;
			if (finish > start) {
				start = finish;
				from = pred;
			}
		}
		earliestStart.set(id, start);
		earliestFinish.set(id, start + (leaves.get(id)?.duration ?? 0));
		cameFrom.set(id, from);
	}

	// Over CONNECTED nodes only. Critical-path analysis assumes unlimited
	// parallelism, so an item with no dependencies constrains nothing however
	// large it is — a 50-day independent task can run alongside everything else.
	// Including it would report a "dependency floor" that is really just the
	// biggest ticket on the board, which is a different (and misleading) claim.
	const projectEnd = Math.max(
		0,
		...order.filter((id) => connected.has(id)).map((id) => earliestFinish.get(id) ?? 0),
	);

	// Backward pass: latest finish/start, then slack.
	const latestFinish = new Map<string, number>();
	for (const id of [...order].reverse()) {
		const nexts = successors.get(id) ?? [];
		const finish =
			nexts.length === 0
				? projectEnd
				: Math.min(
						...nexts.map(
							(next) => (latestFinish.get(next) ?? projectEnd) - (leaves.get(next)?.duration ?? 0),
						),
					);
		latestFinish.set(id, finish);
	}
	const slackByIdentifier: Record<string, number> = {};
	for (const id of order) {
		if (!connected.has(id)) continue;
		const identifier = leaves.get(id)?.node.identifier;
		if (!identifier) continue;
		const latestStart = (latestFinish.get(id) ?? 0) - (leaves.get(id)?.duration ?? 0);
		slackByIdentifier[identifier] =
			Math.round((latestStart - (earliestStart.get(id) ?? 0)) * 100) / 100;
	}

	// Walk back from the latest-finishing node to recover the chain.
	let tail: string | null = null;
	for (const id of order) {
		if ((earliestFinish.get(id) ?? 0) === projectEnd && connected.has(id)) tail = id;
	}
	const chainIds: string[] = [];
	for (let id = tail; id !== null; id = cameFrom.get(id) ?? null) {
		chainIds.unshift(id);
	}

	const chain: CriticalPathNode[] = chainIds.map((id) => {
		const leaf = leaves.get(id) as Leaf;
		return {
			identifier: leaf.node.identifier,
			title: leaf.node.title,
			effortDays: leaf.node.effortDays,
			status: leaf.node.status,
			done: leaf.done,
			earliestStart: earliestStart.get(id) ?? 0,
			earliestFinish: earliestFinish.get(id) ?? 0,
		};
	});

	// Unestimated = no effort line AND not already finished. A done item needs no
	// estimate, so counting it would overstate the uncertainty.
	const unestimatedOnChain = chain.filter((n) => n.effortDays === null && !n.done).length;

	// The biggest lever: finishing one item removes its duration from the floor,
	// but only if it sits ON the critical chain — reducing a slack item changes
	// nothing, which is exactly the insight worth surfacing.
	let biggestLever: CriticalPathResult["biggestLever"] = null;
	for (const node of chain) {
		if (node.done || node.effortDays === null) continue;
		if (biggestLever === null || node.effortDays > biggestLever.daysSaved) {
			biggestLever = {
				identifier: node.identifier ?? node.title,
				title: node.title,
				daysSaved: node.effortDays,
			};
		}
	}

	return {
		chain,
		totalDays: Math.round(projectEnd * 100) / 100,
		unestimatedOnChain,
		isLowerBound: unestimatedOnChain > 0,
		slackByIdentifier,
		biggestLever,
		consideredLeaves: leaves.size,
		doneLeaves: [...leaves.values()].filter((l) => l.done).length,
		connectedLeaves: connected.size,
		cycles: [],
	};
}
