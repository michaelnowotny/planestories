import { describe, expect, test } from "bun:test";
import type { AtlasGraph, AtlasNode } from "../../../src/atlas/model.ts";
import {
	type BoardHealthRow,
	boardHealth,
	buildTrend,
	formatTrend,
} from "../../../src/sync/trend.ts";

function story(id: string, over: Partial<AtlasNode> = {}): AtlasNode {
	return {
		id,
		kind: "story",
		title: id,
		identifier: id.toUpperCase(),
		url: null,
		status: "Todo",
		statusGroup: "unstarted",
		labels: [],
		assignee: null,
		effortDays: null,
		priority: null,
		criteria: [],
		quality: null,
		children: [],
		...over,
	} as AtlasNode;
}

function graph(nodes: AtlasNode[], edges: AtlasGraph["edges"] = []): AtlasGraph {
	return {
		project: "P",
		source: "board",
		nodes,
		edges,
		labels: [],
		assignees: [],
		statuses: [],
		counts: { epics: 0, stories: 0, criteria: 0, flagged: 0, edges: edges.length },
	} as AtlasGraph;
}

function row(over: Partial<BoardHealthRow>): BoardHealthRow {
	return {
		takenAt: "2026-08-10T00:00:00Z",
		instance: "ws",
		project: "P",
		epics: 0,
		stories: 0,
		done: 0,
		open: 0,
		unestimated: 0,
		flagged: 0,
		withCriteria: 0,
		criteria: 0,
		dependencies: 0,
		orphans: 0,
		...over,
	};
}

describe("board health from a graph", () => {
	test("counts only OPEN stories as unestimated", () => {
		// Nagging about a finished story's missing estimate is noise, and it would
		// make the metric drift upward as work completes — the wrong direction.
		const epic: AtlasNode = {
			...story("e"),
			kind: "epic",
			children: [
				story("a", { effortDays: null }),
				story("b", { effortDays: null, statusGroup: "completed" }),
				story("c", { effortDays: 2 }),
			],
		} as AtlasNode;
		const h = boardHealth(graph([epic]), "2026-08-10T00:00:00Z", "ws");
		expect(h.stories).toBe(3);
		expect(h.done).toBe(1);
		expect(h.unestimated).toBe(1);
	});

	test("a story with no quality assessment is NOT counted as clean", () => {
		// Absence of a check is not a passing check. `quality: null` must not
		// silently improve the flagged number.
		const flagged = boardHealth(
			graph([story("a", { quality: { ok: false, flags: ["no criteria"] } })]),
			"2026-08-10T00:00:00Z",
			"ws",
		);
		expect(flagged.flagged).toBe(1);
		const unknown = boardHealth(graph([story("b")]), "2026-08-10T00:00:00Z", "ws");
		expect(unknown.flagged).toBe(0);
	});
});

describe("trend series", () => {
	test("NEVER computes a delta across instances", () => {
		// The cutover put the same project on two hosts. A delta spanning them would
		// report a change of SOURCE as a change in the board.
		const series = buildTrend([
			row({ instance: "cloud", takenAt: "2026-08-16T00:00:00Z", stories: 770 }),
			row({ instance: "ce", takenAt: "2026-08-17T00:00:00Z", stories: 777 }),
		]);
		expect(series).toHaveLength(2);
		// Each is the FIRST of its own series, so neither has a delta.
		expect(series.every((r) => r.delta === null)).toBe(true);
	});

	test("a missing night is reported as a gap, not smoothed over", () => {
		const series = buildTrend([
			row({ takenAt: "2026-08-10T00:00:00Z", stories: 100 }),
			row({ takenAt: "2026-08-17T00:00:00Z", stories: 110 }),
		]);
		expect(series[1]?.daysSincePrevious).toBe(7);
		expect(series[1]?.delta?.stories).toBe(10);
		// The renderer must mark it so a week's hole cannot read as a flat week.
		expect(formatTrend(series)).toContain("7d!");
	});

	test("orders each instance by time regardless of input order", () => {
		const series = buildTrend([
			row({ takenAt: "2026-08-12T00:00:00Z", stories: 3 }),
			row({ takenAt: "2026-08-10T00:00:00Z", stories: 1 }),
			row({ takenAt: "2026-08-11T00:00:00Z", stories: 2 }),
		]);
		expect(series.map((r) => r.stories)).toEqual([1, 2, 3]);
		expect(series.map((r) => r.delta?.stories ?? null)).toEqual([null, 1, 1]);
	});

	test("an empty series renders a statement, not a blank table", () => {
		expect(formatTrend([])).toContain("No snapshots matched");
	});
});

describe("trend series key", () => {
	test("two PROJECTS in one workspace are never one series", () => {
		// The CLI keys on host/workspace/PROJECT. Keying on the workspace alone
		// merged DATA (770 stories) with SBOX (12) into a single line reading
		// "stories -758" — a change of project drawn as a board collapse.
		const series = buildTrend([
			row({ instance: "plane-so-bloomenkohlberg/DATA", stories: 770 }),
			row({ instance: "plane-so-bloomenkohlberg/SBOX", stories: 12 }),
		]);
		expect(series.every((r) => r.delta === null)).toBe(true);
	});

	test("two HOSTS sharing a workspace slug are never one series", () => {
		// backup.ts already carries instanceTag() for exactly this: two instances
		// can share a slug, which is why the key includes the host.
		const series = buildTrend([
			row({ instance: "plane-so-archimedes/DATA", stories: 100 }),
			row({ instance: "plane-porcupine-works-archimedes/DATA", stories: 900 }),
		]);
		expect(series.every((r) => r.delta === null)).toBe(true);
	});
});
