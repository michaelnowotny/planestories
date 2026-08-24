import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAllCommands } from "../../../src/cli/register_all.ts";

/**
 * What the ACTION actually receives, for the commands whose wiring had no test.
 *
 * The surface audit found nine commands where the underlying function is well
 * tested but the layer between argv and that function is not — so nothing would
 * notice if a flag were read under the wrong name, defaulted the wrong way, or
 * silently dropped. That is exactly how `--no-estimate` shipped doing nothing.
 *
 * These do NOT run the actions: every one of them needs a live board. A
 * `preAction` hook captures the resolved options and aborts, so the assertion is
 * against the real registered program — no mocks, no network, no fixtures. It
 * proves the action is handed the right values; the function-level tests already
 * prove what it does with them. Those are different claims and both are needed.
 */

class CapturedInvocation extends Error {
	constructor(
		readonly options: Record<string, unknown>,
		readonly args: readonly unknown[],
	) {
		super("captured");
		this.name = "CapturedInvocation";
	}
}

/** Parse real argv against the real program; return what the action would get. */
function invoke(argv: string[]): CapturedInvocation {
	const program = new Command();
	program.name("planestories").enablePositionalOptions().exitOverride();
	registerAllCommands(program);
	program.hook("preAction", (_root, actionCommand) => {
		// `processedArgs` is what commander passes to the action — a variadic
		// argument arrives there as ONE array. `.args` is the flat raw list, which
		// is a different thing and would have made the `set` assertion below pass
		// for the wrong reason.
		throw new CapturedInvocation(actionCommand.opts(), actionCommand.processedArgs);
	});

	try {
		program.parse(["node", "planestories", ...argv]);
	} catch (error) {
		if (error instanceof CapturedInvocation) return error;
		throw error;
	}
	throw new Error(`No action was reached for: ${argv.join(" ")}`);
}

const opts = (argv: string[]): Record<string, unknown> => invoke(argv).options;

describe("export — action wiring", () => {
	test("-s/--status is REPEATABLE and collects into an array", () => {
		// A custom `collect` reducer with an array default: the shape most likely to
		// silently degrade to last-wins, which would quietly narrow an export.
		expect(opts(["export", "-s", "Todo", "-s", "In Progress"]).status).toEqual([
			"Todo",
			"In Progress",
		]);
		expect(opts(["export"]).status).toEqual([]);
	});

	test("the boolean filters arrive as booleans, defaulting off", () => {
		const on = opts(["export", "--open-only", "--sync-criteria", "--include-archived"]);
		expect(on.openOnly).toBe(true);
		expect(on.syncCriteria).toBe(true);
		expect(on.includeArchived).toBe(true);

		const off = opts(["export"]);
		expect(off.openOnly).toBe(false);
		expect(off.syncCriteria).toBe(false);
		expect(off.includeArchived).toBe(false);
	});

	test("output, project, issues and label reach the action verbatim", () => {
		const parsed = opts([
			"export",
			"-o",
			"exports/board.md",
			"-p",
			"Data Platform",
			"-i",
			"DATA-1,DATA-2",
			"-l",
			"ingestion",
		]);
		expect(parsed.output).toBe("exports/board.md");
		expect(parsed.project).toBe("Data Platform");
		expect(parsed.issues).toBe("DATA-1,DATA-2");
		expect(parsed.label).toBe("ingestion");
	});
});

describe("set — action wiring", () => {
	test("identifiers are VARIADIC, so a multi-item transition is not silently one item", () => {
		const captured = invoke(["set", "DATA-1", "DATA-2", "DATA-3", "--status", "Done"]);
		expect(captured.args[0]).toEqual(["DATA-1", "DATA-2", "DATA-3"]);
		expect(captured.options.status).toBe("Done");
	});

	test("priority and evidence reach the action", () => {
		const parsed = opts(["set", "DATA-1", "--priority", "urgent", "-e", "abc123; verified"]);
		expect(parsed.priority).toBe("urgent");
		expect(parsed.evidence).toBe("abc123; verified");
	});
});

describe("projects — action wiring", () => {
	test("reaches its action with the context it was given", () => {
		expect(opts(["projects", "--context", "ce"]).context).toBe("ce");
	});
});

describe("groom — action wiring", () => {
	test("--write-back is VARIADIC and --yes is the apply switch", () => {
		// groom's default is dry-run; `--yes` is the only thing between a report and
		// a mutation, so its wiring is load-bearing.
		const parsed = opts(["groom", "--write-back", "a.md", "b.md", "--yes"]);
		expect(parsed.writeBack).toEqual(["a.md", "b.md"]);
		expect(parsed.yes).toBe(true);
		expect(opts(["groom"]).yes).toBeFalsy();
	});
});

describe("replicate subcommands — action wiring", () => {
	test("backup: --retain arrives as its documented string default", () => {
		const base = [
			"replicate",
			"backup",
			"--from",
			"cloud",
			"-p",
			"Data Platform",
			"--dir",
			"/tmp/backups",
		];
		expect(opts(base).retain).toBe("14");
		expect(opts([...base, "--retain", "30"]).retain).toBe("30");
	});

	test("backup: --no-check-fresh INVERTS, and absent means the check runs", () => {
		// The reading code is `checkFresh: options.checkFresh !== false`. If commander
		// ever stored this under `noCheckFresh`, the self-check would silently never
		// be skippable — or worse, never run.
		const base = [
			"replicate",
			"backup",
			"--from",
			"cloud",
			"-p",
			"Data Platform",
			"--dir",
			"/tmp/backups",
		];
		expect(opts(base).checkFresh).toBe(true);
		expect(opts([...base, "--no-check-fresh"]).checkFresh).toBe(false);
	});

	test("apply: --yes is what separates a dry-run from writing a whole project", () => {
		const dry = opts(["replicate", "apply", "--to", "ce", "--snapshot", "s.json"]);
		expect(dry.yes).toBeFalsy();
		expect(opts(["replicate", "apply", "--to", "ce", "--snapshot", "s.json", "--yes"]).yes).toBe(
			true,
		);
	});

	test("apply: --no-exact-identifiers INVERTS, and absent means exact is required", () => {
		// `noExactIdentifiers: options.exactIdentifiers === false`. Getting this
		// backwards would accept renumbering on a migration whose entire promise is
		// that PROJECT-N identifiers survive.
		const base = ["replicate", "apply", "--to", "ce", "--snapshot", "s.json"];
		expect(opts(base).exactIdentifiers).toBe(true);
		expect(opts([...base, "--no-exact-identifiers"]).exactIdentifiers).toBe(false);
	});

	test("apply: destination overrides and resume controls reach the action", () => {
		const parsed = opts([
			"replicate",
			"apply",
			"--to",
			"ce",
			"--snapshot",
			"s.json",
			"--dest-name",
			"New Name",
			"--dest-identifier",
			"NEW",
			"--journal",
			"/tmp/j.jsonl",
			"--limit",
			"50",
		]);
		expect(parsed.destName).toBe("New Name");
		expect(parsed.destIdentifier).toBe("NEW");
		expect(parsed.journal).toBe("/tmp/j.jsonl");
		expect(parsed.limit).toBe("50");
	});

	test("verify: journal, export-file and the report path are distinct options", () => {
		// `-o, --out` and `--export-file` are easy to transpose; one writes a report
		// and the other reads a corpus to cross-check against.
		const parsed = opts([
			"replicate",
			"verify",
			"--to",
			"ce",
			"--snapshot",
			"s.json",
			"--journal",
			"/tmp/j.jsonl",
			"--export-file",
			"exports/board.md",
			"-o",
			"/tmp/report.json",
		]);
		expect(parsed.journal).toBe("/tmp/j.jsonl");
		expect(parsed.exportFile).toBe("exports/board.md");
		expect(parsed.out).toBe("/tmp/report.json");
	});

	test("relink: --yes is the apply switch, and the journal is the mapping source", () => {
		const parsed = opts([
			"replicate",
			"relink",
			"--to",
			"ce",
			"--snapshot",
			"s.json",
			"--journal",
			"/tmp/j.jsonl",
			"--yes",
			"stories/",
		]);
		expect(parsed.journal).toBe("/tmp/j.jsonl");
		expect(parsed.yes).toBe(true);
	});

	test("freshness: --quick and --deep are separate switches, both off by default", () => {
		const base = ["replicate", "freshness", "--from", "cloud", "--snapshot", "s.json"];
		expect(opts(base).quick).toBeFalsy();
		expect(opts([...base, "--quick"]).quick).toBe(true);
	});
});

describe("the action-suppressing flags — the ones whose failure mode is DOING something", () => {
	// These four were the last untested options in the whole surface, and they
	// share a shape: if the flag does nothing, the tool performs an action the
	// operator explicitly told it not to perform. That is a worse failure than a
	// filter that does not filter.

	test("import --no-write-back INVERTS, and absent means write-back happens", () => {
		// Read as `noWriteBack: !options.writeBack`. If the mapping moved, import
		// would stamp plane_id/plane_hash into story files that asked to be left
		// alone — a mutation of the user's source, not just a wrong report.
		expect(opts(["import", "stories.md"]).writeBack).toBe(true);
		expect(opts(["import", "stories.md", "--no-write-back"]).writeBack).toBe(false);
	});

	test("delete --no-write-back INVERTS the same way", () => {
		const base = ["delete", "-p", "Data Platform"];
		expect(opts(base).writeBack).toBe(true);
		expect(opts([...base, "--no-write-back"]).writeBack).toBe(false);
	});

	test("delete --archive-label reaches the action, and --archive is separate", () => {
		// Two related options: one switches delete into archive mode, the other
		// names the label. Transposing them would archive under the wrong label or
		// delete when asked to archive.
		const parsed = opts([
			"delete",
			"-p",
			"Data Platform",
			"--archive",
			"--archive-label",
			"retired",
		]);
		expect(parsed.archive).toBe(true);
		expect(parsed.archiveLabel).toBe("retired");
	});

	test("doctor --no-fail-on-findings INVERTS, and absent means findings exit non-zero", () => {
		// Read as `options.failOnFindings !== false`. This is a CI gate: if the flag
		// stopped working, either CI goes green on a rotten board, or a pipeline
		// that opted out starts failing. Both are silent until someone is paged.
		expect(opts(["doctor", "-p", "Data Platform"]).failOnFindings).toBe(true);
		expect(opts(["doctor", "-p", "Data Platform", "--no-fail-on-findings"]).failOnFindings).toBe(
			false,
		);
	});
});

describe("the harness itself", () => {
	test("the action never runs — otherwise these would need a live board", () => {
		// If the hook stopped aborting, every test above would start making network
		// calls and the failure would look like flakiness rather than a broken guard.
		expect(() => invoke(["projects"])).toThrow(CapturedInvocation);
	});

	test("an unknown option is still rejected, so a typo cannot pass silently", () => {
		expect(() => invoke(["projects", "--not-a-real-option"])).toThrow(/unknown option/i);
	});
});
