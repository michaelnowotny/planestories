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

/** A refusal: the graph has a cycle, so a longest path is undefined. */
export interface CriticalPathRefused {
	ok: false;
	/** Dependency cycles, as identifier lists. Always non-empty here. */
	cycles: string[][];
	consideredLeaves: number;
	doneLeaves: number;
}

export interface CriticalPathComputed {
	ok: true;
	/** The longest dependency chain, in order. Empty when nothing is connected. */
	chain: CriticalPathNode[];
	/**
	 * Summed effort along the chain. A LOWER BOUND when `isLowerBound`.
	 *
	 * ABSENT when `chain` is empty. Nothing connected is not a floor of zero, and
	 * a `0` sitting under this key is exactly what a script reads as one.
	 */
	totalDays?: number;
	/**
	 * Connected, unfinished leaves with no estimate — ANYWHERE in the dependency
	 * graph, not merely on the winning chain. An unestimated item that lost the
	 * comparison *because* it was treated as 0 is exactly the one that can make
	 * this total wrong, so counting only chain members would flag the harmless
	 * case and miss the dangerous one.
	 */
	unestimated: number;
	/**
	 * IDENTIFIERS of those stories, not merely how many.
	 *
	 * The atlas tooltip tells the operator to "use the no-estimate filter to find
	 * them", so the filter must select exactly this set. Deriving it a second way
	 * in the browser produced two different definitions one commit apart — the
	 * tooltip counted expanded connected LEAVES while the filter counted literal
	 * edge endpoints, so after an epic edge was expanded the very stories that
	 * made the floor a lower bound were invisible to the control named for
	 * finding them.
	 */
	unestimatedIdentifiers: string[];
	isLowerBound: boolean;
	/** Slack in days per identifier: how long it can slip without moving the end. */
	slackByIdentifier: Record<string, number>;
	/**
	 * The item whose completion shortens the floor MOST, and by how much.
	 *
	 * `daysSaved` is the measured drop in the floor when that item's duration goes
	 * to zero — NOT the item's own duration. Those differ whenever a near-critical
	 * path exists: finishing a 10-day item on a 13-day chain with an 11-day
	 * alternative saves 2 days, not 10. The largest item is frequently not the
	 * biggest lever.
	 */
	biggestLever: { identifier: string; title: string; daysSaved: number } | null;
	consideredLeaves: number;
	doneLeaves: number;
	connectedLeaves: number;
	/** `blocks` edges synthesized by expanding an epic endpoint to its leaves. */
	expandedEdges: number;
	cycles: [];
}

export type CriticalPathResult = CriticalPathRefused | CriticalPathComputed;

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

	// Descendant leaves per container, so a `blocks` edge touching an EPIC is
	// expanded rather than dropped. People really do write "this spike blocks the
	// epic", and silently discarding that edge removes a constraint from a
	// schedule calculation — the floor comes out too short.
	const leavesUnder = new Map<string, string[]>();
	const collect = (node: AtlasNode): string[] => {
		if (leaves.has(node.id)) return [node.id];
		const out: string[] = [];
		for (const child of node.children ?? []) out.push(...collect(child));
		leavesUnder.set(node.id, out);
		return out;
	};
	for (const node of graph.nodes) collect(node);

	const endpoints = (id: string): string[] => (leaves.has(id) ? [id] : (leavesUnder.get(id) ?? []));

	const doneLeaves = [...leaves.values()].filter((l) => l.done).length;

	const successors = new Map<string, string[]>();
	const predecessors = new Map<string, string[]>();
	const connected = new Set<string>();
	let expandedEdges = 0;
	for (const edge of graph.edges) {
		// "blocks" only: `relates` carries no ordering, so using it would invent a
		// constraint that nobody declared.
		if (edge.type !== "blocks") continue;
		const sources = endpoints(edge.source);
		const targets = endpoints(edge.target);
		if (sources.length === 0 || targets.length === 0) continue;
		if (sources.length > 1 || targets.length > 1)
			expandedEdges += sources.length * targets.length - 1;
		for (const s of sources) {
			for (const t of targets) {
				if (s === t) continue;
				successors.set(s, [...(successors.get(s) ?? []), t]);
				predecessors.set(t, [...(predecessors.get(t) ?? []), s]);
				connected.add(s);
				connected.add(t);
			}
		}
	}

	const ids = [...leaves.keys()];
	const label = (id: string) => leaves.get(id)?.node.identifier ?? leaves.get(id)?.node.title ?? id;

	const cycles = findCycles(ids, successors, label);
	if (cycles.length > 0) {
		// REFUSE, and in a shape that cannot be mistaken for success: there is no
		// `totalDays: 0` here for a `jq .totalDays` to pick up.
		return { ok: false, cycles, consideredLeaves: leaves.size, doneLeaves };
	}

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

	/**
	 * One forward pass. `zeroed` lets the caller ask "what if this item were
	 * finished?" without rebuilding anything — which is how the lever is measured
	 * rather than guessed.
	 */
	const forward = (zeroed?: string) => {
		const es = new Map<string, number>();
		const ef = new Map<string, number>();
		const from = new Map<string, string | null>();
		for (const id of order) {
			let start = 0;
			let via: string | null = null;
			for (const pred of predecessors.get(id) ?? []) {
				const finish = ef.get(pred) ?? 0;
				if (finish > start) {
					start = finish;
					via = pred;
				}
			}
			const duration = id === zeroed ? 0 : (leaves.get(id)?.duration ?? 0);
			es.set(id, start);
			ef.set(id, start + duration);
			from.set(id, via);
		}
		// Connected nodes only: CPM assumes unlimited parallelism, so an item with
		// no dependencies constrains nothing however large it is.
		const end = Math.max(
			0,
			...order.filter((id) => connected.has(id)).map((id) => ef.get(id) ?? 0),
		);
		return { es, ef, from, end };
	};

	const base = forward();
	const projectEnd = base.end;

	// Backward pass for slack.
	const latestFinish = new Map<string, number>();
	for (const id of [...order].reverse()) {
		const nexts = successors.get(id) ?? [];
		latestFinish.set(
			id,
			nexts.length === 0
				? projectEnd
				: Math.min(
						...nexts.map(
							(next) => (latestFinish.get(next) ?? projectEnd) - (leaves.get(next)?.duration ?? 0),
						),
					),
		);
	}
	const slackByIdentifier: Record<string, number> = {};
	for (const id of order) {
		if (!connected.has(id)) continue;
		const identifier = leaves.get(id)?.node.identifier;
		if (!identifier) continue;
		const latestStart = (latestFinish.get(id) ?? 0) - (leaves.get(id)?.duration ?? 0);
		slackByIdentifier[identifier] = Math.round((latestStart - (base.es.get(id) ?? 0)) * 100) / 100;
	}

	let tail: string | null = null;
	for (const id of order) {
		if ((base.ef.get(id) ?? 0) === projectEnd && connected.has(id)) tail = id;
	}
	const chainIds: string[] = [];
	for (let id = tail; id !== null; id = base.from.get(id) ?? null) chainIds.unshift(id);

	const chain: CriticalPathNode[] = chainIds.map((id) => {
		const leaf = leaves.get(id) as Leaf;
		return {
			identifier: leaf.node.identifier,
			title: leaf.node.title,
			effortDays: leaf.node.effortDays,
			status: leaf.node.status,
			done: leaf.done,
			earliestStart: base.es.get(id) ?? 0,
			earliestFinish: base.ef.get(id) ?? 0,
		};
	});

	// Unestimated across the WHOLE connected remaining graph. The item that makes
	// the total wrong is typically the one that LOST the comparison because it was
	// treated as zero — counting only the chain flags the visible case and misses
	// the dangerous one.
	const unestimatedLeaves = [...connected].filter((id) => {
		const leaf = leaves.get(id);
		return leaf !== undefined && !leaf.done && leaf.node.effortDays === null;
	});
	const unestimated = unestimatedLeaves.length;
	const unestimatedIdentifiers = unestimatedLeaves
		.map((id) => leaves.get(id)?.node.identifier)
		.filter((v): v is string => typeof v === "string")
		.sort();

	// The lever, MEASURED: zero each chain item in turn and take the real drop in
	// the floor. A near-critical path caps the saving, so the largest item is
	// often not the biggest lever — and sometimes saves the least.
	let biggestLever: CriticalPathComputed["biggestLever"] = null;
	for (const node of chain) {
		if (node.done) continue;
		const id = chainIds[chain.indexOf(node)];
		if (id === undefined) continue;
		const saved = Math.round((projectEnd - forward(id).end) * 100) / 100;
		if (saved <= 0) continue;
		if (biggestLever === null || saved > biggestLever.daysSaved) {
			biggestLever = {
				identifier: node.identifier ?? node.title,
				title: node.title,
				daysSaved: saved,
			};
		}
	}

	return {
		ok: true,
		chain,
		// Omitted entirely when nothing is connected — the same discipline as the
		// cycle refusal above, for the same reason. The human formatter and the
		// atlas gauge both special-cased the empty chain; `--json` did not, so
		// `jq .totalDays` read `0` off a board with no dependency structure and got
		// a floor that was never computed. An absent key cannot be misread.
		...(chain.length > 0 ? { totalDays: Math.round(projectEnd * 100) / 100 } : {}),
		unestimated,
		unestimatedIdentifiers,
		isLowerBound: unestimated > 0,
		slackByIdentifier,
		biggestLever,
		consideredLeaves: leaves.size,
		doneLeaves,
		connectedLeaves: connected.size,
		expandedEdges,
		cycles: [],
	};
}
