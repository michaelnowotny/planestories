import { describe, expect, test } from "bun:test";
import {
	formatPacedOpening,
	formatPhaseProgress,
	PacedProgress,
} from "../../../src/cli/run_progress.ts";

describe("paced progress formatting", () => {
	test("the opening line names the host, the workspace, and the rate", () => {
		expect(
			formatPacedOpening({
				baseUrl: "https://plane.example/",
				workspaceSlug: "archimedes",
				project: "Data Platform",
				requestsPerMinute: 600,
			}),
		).toBe(
			"Paced run starting · plane.example · workspace archimedes · project Data Platform · 600/min.",
		);
		expect(
			formatPacedOpening({
				baseUrl: "https://plane.example",
				workspaceSlug: "archimedes",
				requestsPerMinute: 60,
			}),
		).toBe("Paced run starting · plane.example · workspace archimedes · 60/min.");
	});

	test("an estimate is the measured remainder, and an unknown total is not a remainder", () => {
		expect(formatPhaseProgress({ label: "relations", done: 1, total: 4, elapsedMs: 1000 })).toBe(
			"  relations: 1/4 (~3s left)",
		);
		expect(
			formatPhaseProgress({ label: "relations", done: 50, total: 100, elapsedMs: 120_000 }),
		).toBe("  relations: 50/100 (~2m left)");
		expect(formatPhaseProgress({ label: "relations", done: 4, total: 4, elapsedMs: 2000 })).toBe(
			"  relations: 4/4 done in 2s",
		);
		const unknown = formatPhaseProgress({
			label: "work items",
			done: 200,
			total: undefined,
			elapsedMs: 8000,
		});
		expect(unknown).toContain("200 so far");
		expect(unknown).toContain("no estimate");
		expect(unknown).not.toContain("left");
	});

	test("the printer shows the first estimate and the close, and skips the ticks between", () => {
		let now = 1_000_000;
		const chunks: string[] = [];
		const progress = new PacedProgress(
			(chunk) => chunks.push(chunk),
			() => now,
		);
		progress.phase("relations", 0, 4);
		expect(chunks).toEqual([]);
		now += 1000;
		progress.phase("relations", 1, 4);
		now += 1000;
		progress.phase("relations", 2, 4);
		progress.phase("relations", 4, 4);
		const text = chunks.join("");
		expect(text).toContain("relations: 1/4 (~3s left)");
		expect(text).not.toContain("relations: 2/4");
		expect(text).toContain("relations: 4/4 done in 2s");
	});
});
