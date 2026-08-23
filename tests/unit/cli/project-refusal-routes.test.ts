import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAtlasCommand } from "../../../src/cli/commands/atlas.ts";
import { registerAuditCommand } from "../../../src/cli/commands/audit.ts";
import { registerBoardCommand } from "../../../src/cli/commands/board.ts";
import { registerCriticalPathCommand } from "../../../src/cli/commands/critical-path.ts";
import { registerGraphQueryCommands } from "../../../src/cli/commands/graph-queries.ts";
import { registerCountCommand, registerLsCommand } from "../../../src/cli/commands/query.ts";
import { registerShowCommand } from "../../../src/cli/commands/show.ts";
import {
	describeProjectSelection,
	selectProjectRefusal,
} from "../../../src/cli/project_selection.ts";

/**
 * House rule 3: a refusal names what would answer it. The shared "no project
 * selected" refusal used to name TWO routes unconditionally — `<file>` and
 * `--project` — from a helper that cannot see which of them the calling command
 * registers.
 *
 * Measured against the live board, `audit` accepted NEITHER:
 *
 *   $ planestories audit --since 72h
 *   ConfigError: Provide a <file> argument, or --project <name> (or a
 *                defaultProject) to read the live board.
 *   $ planestories audit --since 24h --project "Data Platform"
 *   error: unknown option '--project'
 *
 * — the first thing a new operator hits, and both offered answers are false.
 * Seven more commands (`show`, `ls`, `count`, `board fetch`, and the graph
 * verbs) named a `<file>` argument they do not accept.
 *
 * The fix derives the sentence from commander's ACTUAL registration, so it
 * cannot drift from the surface. These tests pin the derivation against the
 * real registered commands rather than a hand-maintained table — naming the two
 * commands that already bit us cannot catch the third.
 */

function program(): Command {
	const root = new Command();
	registerAtlasCommand(root);
	registerAuditCommand(root);
	registerBoardCommand(root);
	registerCriticalPathCommand(root);
	registerGraphQueryCommands(root);
	registerLsCommand(root);
	registerCountCommand(root);
	registerShowCommand(root);
	return root;
}

function find(root: Command, path: string): Command {
	const found = path
		.split(" ")
		.reduce<Command | undefined>(
			(parent: Command | undefined, name) =>
				parent?.commands.find((candidate) => candidate.name() === name),
			root,
		);
	if (!found) throw new Error(`No command registered at "${path}"`);
	return found;
}

/** Every registered command that can be asked to read a live board. */
const GRAPH_BACKED = [
	"atlas",
	"audit",
	"board fetch",
	"critical-path",
	"ready",
	"inconsistent",
	"blocked",
	"orphans",
	"abandoned",
	"ls",
	"count",
	"show",
];

describe("no-project refusal — it may only name routes the command registers", () => {
	test("audit accepts --project, so the sentence offering it is true", () => {
		// RED before the fix: commander rejected it with "unknown option '--project'"
		// while the refusal told the operator to pass exactly that.
		const audit = find(program(), "audit");
		expect(audit.options.some((option) => option.long === "--project")).toBe(true);
		expect(describeProjectSelection(audit).projectOption).toBe(true);
	});

	test.each(GRAPH_BACKED)("%s's refusal matches its own registered surface", (path) => {
		const command = find(program(), path);
		const routes = describeProjectSelection(command);
		const message = selectProjectRefusal(routes);

		// `show <identifier>` has a positional that is NOT a stories file; offering
		// it as a board-selection route would be the same false suggestion.
		const registersFile = command.registeredArguments.some(
			(argument) => argument.name() === "file",
		);
		const registersProject = command.options.some((option) => option.long === "--project");
		expect(routes.projectOption).toBe(registersProject);
		expect(routes.fileArgument !== null).toBe(registersFile);

		// The two claims that were false in production.
		expect(message.includes("file")).toBe(registersFile);
		expect(message.includes("--project")).toBe(registersProject);
		// Whatever the surface, the always-true route is offered, so the refusal is
		// never a dead end.
		expect(message).toContain("defaultProject");
	});

	test("a command with no file argument never mentions one", () => {
		// The seven-command half of the defect, pinned on the smallest case.
		const message = selectProjectRefusal({ fileArgument: null, projectOption: true });
		expect(message).not.toContain("file");
		expect(message).toContain("--project");
	});

	test("a command with neither route still names an answer", () => {
		// Degrading safely matters more than degrading richly: a command that
		// forgets to pass its routes gets a sentence that is less helpful but
		// cannot be false.
		const message = selectProjectRefusal({ fileArgument: null, projectOption: false });
		expect(message).not.toContain("--project");
		expect(message).not.toContain("file");
		expect(message).toContain("defaultProject");
		expect(message).toContain("--context");
	});

	test("the file argument is quoted as the command actually spells it", () => {
		// `atlas` takes [file]; `critical-path` takes [file]. If one ever becomes
		// required, the sentence must follow rather than guess.
		const root = program();
		for (const path of ["atlas", "critical-path"]) {
			const command = find(root, path);
			const routes = describeProjectSelection(command);
			expect(routes.fileArgument).not.toBeNull();
			expect(selectProjectRefusal(routes)).toContain(routes.fileArgument as string);
		}
	});
});
