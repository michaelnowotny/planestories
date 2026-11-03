import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Same edges as the unit tie-break, driven through `critical-path <file>`.
 * Listing the detour's `blocks:` first used to report 8 items; listing the
 * direct edge first reported 4. Both files must name the direct chain.
 */

function runCli(args: string[], cwd: string): { code: number; out: string; err: string } {
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	const env: Record<string, string> = { FORCE_COLOR: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawnSync(["bun", "run", cli, ...args], { env, cwd });
	return {
		code: proc.exitCode ?? -1,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function story(
	identifier: string,
	options: { status?: string; effort?: number; blocks?: string[]; blockedBy?: string[] },
): string {
	const lines = [
		`## ${identifier}`,
		"",
		"```yaml",
		`plane_identifier: ${identifier}`,
		options.status ? `status: ${options.status}` : "status: Backlog",
		options.effort === undefined ? "" : `effort_days: ${options.effort}`,
		options.blocks?.length ? `blocks: [${options.blocks.join(", ")}]` : "",
		options.blockedBy?.length ? `blocked_by: [${options.blockedBy.join(", ")}]` : "",
		"```",
		"",
		"Work.",
		"",
	];
	return lines.filter((line) => line !== "").join("\n");
}

/** Detour blockers are written first, so their edges are inserted first. */
function detourFirst(): string {
	return [
		"---",
		'project: "Data Platform"',
		"---",
		"",
		story("DATA-2725", {
			status: "Done",
			effort: 3,
			blocks: ["DATA-2636"],
			blockedBy: ["DATA-2716"],
		}),
		story("DATA-2716", {
			status: "Done",
			effort: 3,
			blocks: ["DATA-2725", "DATA-2636"],
			blockedBy: ["DATA-2709"],
		}),
		story("DATA-2709", {
			status: "Done",
			effort: 2.5,
			blocks: ["DATA-2716"],
			blockedBy: ["DATA-2703"],
		}),
		story("DATA-2703", {
			status: "Done",
			effort: 2.5,
			blocks: ["DATA-2709"],
			blockedBy: ["DATA-2631"],
		}),
		story("DATA-2631", { status: "Done", effort: 3, blocks: ["DATA-2703", "DATA-2636"] }),
		story("DATA-2636", { effort: 5, blocks: ["DATA-2637"] }),
		story("DATA-2637", { effort: 8, blocks: ["DATA-2640"] }),
		story("DATA-2640", { effort: 4 }),
	].join("\n");
}

/** The direct edge is written first. */
function directFirst(): string {
	return [
		"---",
		'project: "Data Platform"',
		"---",
		"",
		story("DATA-2631", { status: "Done", effort: 3, blocks: ["DATA-2636", "DATA-2703"] }),
		story("DATA-2703", { status: "Done", effort: 2.5, blocks: ["DATA-2709"] }),
		story("DATA-2709", { status: "Done", effort: 2.5, blocks: ["DATA-2716"] }),
		story("DATA-2716", { status: "Done", effort: 3, blocks: ["DATA-2725", "DATA-2636"] }),
		story("DATA-2725", { status: "Done", effort: 3, blocks: ["DATA-2636"] }),
		story("DATA-2636", { effort: 5, blocks: ["DATA-2637"] }),
		story("DATA-2637", { effort: 8, blocks: ["DATA-2640"] }),
		story("DATA-2640", { effort: 4 }),
	].join("\n");
}

const SHORT_CHAIN = ["DATA-2631", "DATA-2636", "DATA-2637", "DATA-2640"];

test("critical-path names the same chain whichever way the file lists the edges", () => {
	const directory = mkdtempSync(join(tmpdir(), "planestories-critical-path-"));
	try {
		writeFileSync(join(directory, "detour-first.md"), detourFirst());
		writeFileSync(join(directory, "direct-first.md"), directFirst());
		for (const file of ["detour-first.md", "direct-first.md"]) {
			const result = runCli(["critical-path", file, "--json"], directory);
			expect(result.code).toBe(0);
			const output = JSON.parse(result.out);
			expect(output.chain.map((node: { identifier: string }) => node.identifier)).toEqual(
				SHORT_CHAIN,
			);
			expect(output.totalDays).toBe(17);
			expect(output).not.toHaveProperty("source");
		}
		const human = runCli(["critical-path", "detour-first.md"], directory);
		expect(human.code).toBe(0);
		expect(human.out).toContain("17 dev-days across 4 items");
		expect(human.out).not.toContain("DATA-2703");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
