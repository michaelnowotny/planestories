import type { AtlasGraph, AtlasNode } from "../atlas/model.ts";

/**
 * Board-health trend across nightly snapshots.
 *
 * The nightly backups already hold a full-fidelity board every night; reading
 * them offline turns insurance into a time series for free — zero API calls,
 * and history no live query can reconstruct (Plane will not tell you how many
 * stories lacked an estimate three weeks ago).
 *
 * Two honesty rules shape the output:
 *
 * 1. SNAPSHOTS FROM DIFFERENT INSTANCES ARE NOT ONE SERIES. A cutover means the
 *    same project exists on two hosts with independently-evolving content;
 *    concatenating them draws a cliff that is a change of SOURCE, not a change
 *    in the board. Rows carry their instance and the caller must not merge
 *    across them silently.
 * 2. A MISSING NIGHT IS A GAP, NOT A ZERO. Deltas are computed against the
 *    previous row PRESENT, and the row records how many days separate them, so
 *    a week-long hole cannot read as a flat week.
 */

export interface BoardHealthRow {
	/** Snapshot timestamp (ISO), the x-axis. */
	takenAt: string;
	/** Host the snapshot was read from — the series key. */
	instance: string;
	project: string;
	epics: number;
	stories: number;
	/** Stories in a completed or cancelled state. */
	done: number;
	open: number;
	/** OPEN stories with no parseable `**Effort:**` line. */
	unestimated: number;
	/** Stories the spec-quality overlay flagged. */
	flagged: number;
	/** Stories carrying at least one acceptance criterion. */
	withCriteria: number;
	criteria: number;
	/** Directed dependency edges. */
	dependencies: number;
	/** Stories with no parent epic. */
	orphans: number;
}

export interface TrendRow extends BoardHealthRow {
	/** Whole days since the previous row in the SAME instance series, or null. */
	daysSincePrevious: number | null;
	/** Deltas vs the previous row in this series; null for the first row. */
	delta: null | {
		stories: number;
		done: number;
		unestimated: number;
		flagged: number;
		dependencies: number;
		orphans: number;
	};
}

/** Reduce one graph to a health row. */
export function boardHealth(graph: AtlasGraph, takenAt: string, instance: string): BoardHealthRow {
	let epics = 0;
	let stories = 0;
	let done = 0;
	let unestimated = 0;
	let flagged = 0;
	let withCriteria = 0;
	let criteria = 0;

	const walk = (nodes: AtlasNode[], depth: number): void => {
		for (const n of nodes) {
			if (n.kind === "epic") {
				epics++;
			} else {
				stories++;
				const finished = n.statusGroup === "completed" || n.statusGroup === "cancelled";
				if (finished) done++;
				// Only OPEN work can be "missing an estimate" in any actionable sense:
				// nagging about a finished story's absent effort line is noise.
				else if (n.effortDays === null) unestimated++;
				// `ok === false` is the flagged state; a story with no assessment at all
				// is NOT counted as flagged (absence of a check is not a clean bill).
				if (n.quality && !n.quality.ok) flagged++;
				const c = n.criteria?.length ?? 0;
				criteria += c;
				if (c > 0) withCriteria++;
			}
			walk(n.children ?? [], depth + 1);
		}
	};
	walk(graph.nodes, 0);

	// Top-level non-epic nodes are stories with no parent epic.
	const orphans = graph.nodes.filter((n) => n.kind !== "epic").length;

	return {
		takenAt,
		instance,
		project: graph.project,
		epics,
		stories,
		done,
		open: stories - done,
		unestimated,
		flagged,
		withCriteria,
		criteria,
		dependencies: graph.edges.length,
		orphans,
	};
}

/**
 * Order rows into per-instance series and attach deltas.
 *
 * Deltas never cross an instance boundary: the first row of each series has
 * `delta: null` rather than a difference against some other host's board, which
 * would be a fabricated change.
 */
export function buildTrend(rows: BoardHealthRow[]): TrendRow[] {
	const byInstance = new Map<string, BoardHealthRow[]>();
	for (const row of rows) {
		byInstance.set(row.instance, [...(byInstance.get(row.instance) ?? []), row]);
	}
	const out: TrendRow[] = [];
	for (const [, series] of byInstance) {
		const sorted = [...series].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
		let previous: BoardHealthRow | null = null;
		for (const row of sorted) {
			const daysSincePrevious =
				previous === null
					? null
					: Math.round((Date.parse(row.takenAt) - Date.parse(previous.takenAt)) / 86_400_000);
			out.push({
				...row,
				daysSincePrevious,
				delta:
					previous === null
						? null
						: {
								stories: row.stories - previous.stories,
								done: row.done - previous.done,
								unestimated: row.unestimated - previous.unestimated,
								flagged: row.flagged - previous.flagged,
								dependencies: row.dependencies - previous.dependencies,
								orphans: row.orphans - previous.orphans,
							},
			});
			previous = row;
		}
	}
	return out.sort(
		(a, b) => a.instance.localeCompare(b.instance) || a.takenAt.localeCompare(b.takenAt),
	);
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** Render the series as a table. One block per instance — never merged. */
export function formatTrend(rows: TrendRow[]): string {
	if (rows.length === 0) return "No snapshots matched.";
	const lines: string[] = [];
	const instances = [...new Set(rows.map((r) => r.instance))];

	for (const instance of instances) {
		const series = rows.filter((r) => r.instance === instance);
		lines.push(`${instance}  (${series[0]?.project ?? "?"}) — ${series.length} snapshot(s)`);
		lines.push("  date        stories   done   open  unest  flagged   deps  orphans   gap");
		for (const r of series) {
			const d = r.delta;
			const gap =
				r.daysSincePrevious === null
					? "  —"
					: r.daysSincePrevious > 1
						? `${r.daysSincePrevious}d!` // a hole in the series, called out
						: `${r.daysSincePrevious}d`;
			lines.push(
				`  ${r.takenAt.slice(0, 10)}  ${String(r.stories).padStart(7)}${d ? ` (${signed(d.stories)})`.padEnd(6) : "".padEnd(6)}` +
					`${String(r.done).padStart(5)}${String(r.open).padStart(7)}${String(r.unestimated).padStart(7)}` +
					`${String(r.flagged).padStart(9)}${String(r.dependencies).padStart(7)}${String(r.orphans).padStart(9)}  ${gap}`,
			);
		}
		// The summary compares FIRST to LAST of this series only.
		const first = series[0];
		const last = series[series.length - 1];
		if (first && last && series.length > 1) {
			lines.push("");
			lines.push(
				`  over ${first.takenAt.slice(0, 10)} → ${last.takenAt.slice(0, 10)}: ` +
					`stories ${signed(last.stories - first.stories)}, done ${signed(last.done - first.done)}, ` +
					`unestimated ${signed(last.unestimated - first.unestimated)}, ` +
					`flagged ${signed(last.flagged - first.flagged)}, ` +
					`dependencies ${signed(last.dependencies - first.dependencies)}`,
			);
		}
		lines.push("");
	}
	if (instances.length > 1) {
		lines.push(
			"Series are per-INSTANCE and deliberately not merged: the same project on two hosts",
		);
		lines.push(
			"evolves independently, so a combined line would show a change of source as a trend.",
		);
	}
	return lines.join("\n");
}
