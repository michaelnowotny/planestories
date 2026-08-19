import type { AtlasGraph, AtlasNode } from "./model.ts";

/**
 * Pre-settle the force layout at GENERATION time.
 *
 * The problem this solves, measured rather than guessed:
 *
 *   The browser ran `tick()` exactly ONCE per animation frame, and the
 *   simulation needs 325 ticks for alpha to decay below AMIN. That is 5.4s at a
 *   perfect 60fps and 10-16s at the 20-30fps the settling frames actually cost
 *   — during which the whole board visibly churns and is unusable. The operator
 *   described it exactly: "extremely sluggish for a while in the beginning until
 *   all of the stories have been arranged and then it is usable and fast again."
 *
 * Two hypotheses were wrong before this one, which is why the numbers matter:
 * the O(n²) repulsion measures 2.48ms/tick at 825 nodes (15% of a frame budget,
 * not a stall), and disabling the nebula layer changed nothing. The frame RATE
 * was fine throughout — 30-60fps. There were simply 325 frames of it.
 *
 * So: run the same physics here, once, and ship settled coordinates. The page
 * then opens on an arranged board with the simulation already cold. The browser
 * keeps its own copy of the physics for re-heating after a drag, which is a
 * short local disturbance rather than a full cold start.
 *
 * The constants below are INTERPOLATED into the embedded script (render.ts
 * builds the `const REP=...` line from them), so the two copies of the physics
 * cannot drift apart in their tuning. An earlier version of this comment claimed
 * that while render.ts still carried its own literals — the claim is now true,
 * and a test asserts the emitted HTML contains these exact numbers.
 */
export const PHYSICS = {
	REP: 300,
	SPRING: { parent: 0.12, blocks: 0.03, relates: 0.02 },
	REST: { parent: 26, blocks: 110, relates: 120 },
	GRAV: 0.06,
	VDECAY: 0.7,
	DECAY: 0.012,
	AMIN: 0.02,
} as const;

export interface SettledPosition {
	x: number;
	y: number;
}

interface Body {
	id: string;
	epic: boolean;
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
}

type EdgeKind = "parent" | "blocks" | "relates";

/**
 * Run the layout to convergence and return final positions by node id.
 *
 * Deterministic for a given graph: seeding is a golden-angle spiral and the
 * only random draw is the degenerate-overlap nudge, which cannot fire from this
 * seeding because no two spiral points coincide. Diff-stable output matters —
 * two renders of an unchanged board must not produce different files.
 */
export function settleLayout(graph: AtlasGraph): Record<string, SettledPosition> {
	const nodes: AtlasNode[] = [];
	const childrenOf = new Map<string, string[]>();
	const parentOf = new Map<string, string>();

	(function flatten(list: AtlasNode[], parent: AtlasNode | null): void {
		for (const n of list) {
			nodes.push(n);
			if (parent) {
				parentOf.set(n.id, parent.id);
				childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), n.id]);
			}
			if (n.children?.length) flatten(n.children, n);
		}
	})(graph.nodes, null);

	if (nodes.length === 0) return {};

	// Seed: golden-angle spiral, identical to the browser's `seed()`.
	const bodies = new Map<string, Body>();
	const R = Math.max(200, Math.sqrt(nodes.length) * 30);
	nodes.forEach((n, i) => {
		const a = i * 2.399963;
		const r = R * Math.sqrt(i / nodes.length);
		const wr =
			n.kind === "epic"
				? 13 + Math.min(11, Math.sqrt((childrenOf.get(n.id) ?? []).length) * 1.9)
				: 6;
		bodies.set(n.id, {
			id: n.id,
			epic: n.kind === "epic",
			x: Math.cos(a) * r,
			y: Math.sin(a) * r,
			vx: 0,
			vy: 0,
			r: wr,
		});
	});

	const edges: Array<{ s: string; t: string; type: EdgeKind }> = [];
	for (const [child, par] of parentOf) edges.push({ s: par, t: child, type: "parent" });
	for (const e of graph.edges) {
		if (!bodies.has(e.source) || !bodies.has(e.target)) continue;
		edges.push({ s: e.source, t: e.target, type: e.type === "blocks" ? "blocks" : "relates" });
	}

	// Flat arrays for the hot loop: the browser version does a Map.get per PAIR,
	// which is 340k hash lookups per tick at this board size. Here the inner loop
	// touches only numbers.
	const list = [...bodies.values()];
	const n = list.length;
	const px = new Float64Array(n);
	const py = new Float64Array(n);
	const vx = new Float64Array(n);
	const vy = new Float64Array(n);
	const isEpic = new Uint8Array(n);
	const indexOf = new Map<string, number>();
	list.forEach((b, i) => {
		px[i] = b.x;
		py[i] = b.y;
		isEpic[i] = b.epic ? 1 : 0;
		indexOf.set(b.id, i);
	});
	const radius = list.map((b) => b.r);

	const { REP, SPRING, REST, GRAV, VDECAY, DECAY, AMIN } = PHYSICS;
	let alpha = 1;
	while (alpha > AMIN) {
		for (let i = 0; i < n; i++) {
			const ax = px[i] as number;
			const ay = py[i] as number;
			const aEpic = isEpic[i] === 1;
			for (let j = i + 1; j < n; j++) {
				let dx = ax - (px[j] as number);
				let dy = ay - (py[j] as number);
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.01) {
					// Deterministic nudge: the browser uses Math.random here, but this
					// path is unreachable from spiral seeding, and a random draw would
					// make the emitted file non-diff-stable.
					dx = 0.05;
					dy = -0.05;
					d2 = dx * dx + dy * dy + 0.01;
				}
				const f = (aEpic && isEpic[j] === 1 ? REP * 7 : REP) / d2;
				const fx = dx * f;
				const fy = dy * f;
				vx[i] = (vx[i] as number) + fx * alpha;
				vy[i] = (vy[i] as number) + fy * alpha;
				vx[j] = (vx[j] as number) - fx * alpha;
				vy[j] = (vy[j] as number) - fy * alpha;
			}
		}
		for (const e of edges) {
			const i = indexOf.get(e.s) as number;
			const j = indexOf.get(e.t) as number;
			if (i === undefined || j === undefined) continue;
			const dx = (px[j] as number) - (px[i] as number);
			const dy = (py[j] as number) - (py[i] as number);
			const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
			const rest = e.type === "parent" ? (radius[i] as number) + 16 : REST[e.type];
			const f = ((d - rest) / d) * SPRING[e.type] * alpha;
			const fx = dx * f;
			const fy = dy * f;
			vx[i] = (vx[i] as number) + fx;
			vy[i] = (vy[i] as number) + fy;
			vx[j] = (vx[j] as number) - fx;
			vy[j] = (vy[j] as number) - fy;
		}
		for (let i = 0; i < n; i++) {
			vx[i] = (vx[i] as number) - (px[i] as number) * GRAV * alpha;
			vy[i] = (vy[i] as number) - (py[i] as number) * GRAV * alpha;
			vx[i] = (vx[i] as number) * VDECAY;
			vy[i] = (vy[i] as number) * VDECAY;
			px[i] = (px[i] as number) + (vx[i] as number);
			py[i] = (py[i] as number) + (vy[i] as number);
		}
		alpha *= 1 - DECAY;
	}

	const out: Record<string, SettledPosition> = {};
	for (const [id, i] of indexOf) {
		// Round to 2dp: full float precision would bloat the payload for sub-pixel
		// differences nobody can see, and it keeps the file diff-stable.
		out[id] = {
			x: Math.round((px[i] as number) * 100) / 100,
			y: Math.round((py[i] as number) * 100) / 100,
		};
	}
	return out;
}
