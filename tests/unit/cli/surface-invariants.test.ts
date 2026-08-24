import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command, type Option } from "commander";
import { registerAllCommands } from "../../../src/cli/register_all.ts";

/**
 * Invariants over the WHOLE CLI surface, checked against the real registered
 * program rather than a hand-kept list.
 *
 * Written after `--no-estimate` shipped as a complete no-op. Commander stores a
 * `--no-x` boolean under the UN-prefixed name, the predicate read a key that was
 * never set, and `count --no-estimate --open` printed the unfiltered count. It
 * had a unit test of the underlying function AND a CLI test asserting `--help`
 * mentions the flag. Both passed. **Neither ran the flag.**
 *
 * So these do not ask "is there a test that mentions this option". They ask
 * whether the option is CONNECTED to behaviour at all, and force every new
 * option to be classified rather than quietly unexercised.
 *
 * Deliberately NOT a mutation-testing framework. These are three cheap
 * structural facts that would each have caught a defect we actually shipped.
 */

const ROOT = join(import.meta.dir, "../../..");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith(".ts")) out.push(full);
	}
	return out;
}

const SOURCES = walk(join(ROOT, "src")).map((path) => ({
	path: path.slice(ROOT.length + 1),
	text: readFileSync(path, "utf8"),
}));
const TESTS = walk(join(ROOT, "tests")).map((path) => ({
	path: path.slice(ROOT.length + 1),
	text: readFileSync(path, "utf8"),
}));

interface SurfaceOption {
	command: string;
	flags: string;
	long: string;
	attribute: string;
	option: Option;
}

function surface(): SurfaceOption[] {
	const program = new Command();
	program.name("planestories").enablePositionalOptions();
	registerAllCommands(program);

	const rows: SurfaceOption[] = [];
	const collect = (command: Command, prefix: string[]): void => {
		const path = [...prefix, command.name()].filter(Boolean);
		for (const option of command.options) {
			rows.push({
				command: path.join(" "),
				flags: option.flags,
				long: option.long ?? option.short ?? "",
				attribute: option.attributeName(),
				option,
			});
		}
		for (const child of command.commands) collect(child, path);
	};
	collect(program, []);
	return rows;
}

const SURFACE = surface();

/**
 * The module that REGISTERS this option's command.
 *
 * The first version took `SOURCES.find(f => f.text.includes(flags))` — the first
 * file in readdir order quoting that flag string. `"--open"` appears in both
 * `atlas.ts` (open the rendered file) and `query.ts` (filter to open stories),
 * so `ls --open` resolved to ATLAS and was "read" because atlas reads
 * `options.open`. Deleting the ls filter would not have failed the check.
 * Measured, not theorised: the review ran the heuristic and showed it.
 */
function ownerModule(row: SurfaceOption): { path: string; text: string } | undefined {
	const leaf = row.command.split(" ").at(-1) as string;
	const registering = SOURCES.find((file) => file.text.includes(`.command("${leaf}`));
	// The option must be registered in that same module — a shared `addXOptions`
	// helper lives beside its commands, so this holds for every current option.
	return registering?.text.includes(`"${row.flags}"`) ? registering : undefined;
}
const key = (row: SurfaceOption): string => `${row.command} ${row.long}`;

/**
 * Options with no test that drives them, each with the reason it is acceptable
 * for now. This list may SHRINK freely; adding to it is a deliberate act that
 * shows up in review, which is the whole point — a new option cannot become
 * quietly unexercised.
 */
const UNEXERCISED_BACKLOG: Record<string, string> = {
	// EMPTY — every one of the 251 options is now driven by a test, either through
	// argv or into an action-level entry point. It started at eleven declared plus
	// five undeclared. Keep it empty: an entry here is a promise to come back, and
	// the both-ways check below means a stale promise fails the suite too.
};

/**
 * Commands whose ACTION layer — the thin wiring between argv and the function
 * it calls — has no test of its own. Each is covered at the function level, so
 * the logic is tested; what is not tested is that the command hands it the
 * right arguments. Same rule as the option backlog: shrink freely, and adding
 * an entry is a visible act.
 */
const UNINVOKED_COMMAND_BACKLOG: Record<string, string> = {
	// Empty, and it should stay that way: `action-wiring.test.ts` covers every
	// command's argv -> options mapping through the real registered program.
};

describe("CLI surface — every option is connected to behaviour", () => {
	test("the surface is non-trivial, so a broken enumeration cannot pass vacuously", () => {
		// A test that iterates an empty list passes. Pin the order of magnitude.
		expect(SURFACE.length).toBeGreaterThan(200);
		expect(new Set(SURFACE.map((row) => row.command)).size).toBeGreaterThan(20);
	});

	test("every option's stored attribute is READ by the module that registers it", () => {
		// The `--no-estimate` invariant. Commander stored `estimate`; the code read
		// `noEstimate`; nothing connected them. Verified to fail when that bug is
		// re-introduced — a check nobody has seen fail is not a check.
		//
		// Scoped to the REGISTERING module on purpose: an earlier version searched
		// all of src/, matched `estimate:` in the story-YAML parser, and reported
		// the flag wired while it was dead. It agreed with reality by accident.
		const dead: string[] = [];
		const unresolved: string[] = [];
		for (const row of SURFACE) {
			const owner = ownerModule(row);
			if (!owner) {
				unresolved.push(key(row));
				continue;
			}
			const read = new RegExp(`options\\.${row.attribute}\\b|\\b${row.attribute}\\s*[,}]`);
			if (!read.test(owner.text)) dead.push(`${key(row)} (stored as \`${row.attribute}\`)`);
		}
		// An option whose registering module cannot be located is NOT quietly
		// skipped: an unresolvable owner means this check said nothing about it.
		expect(unresolved).toEqual([]);
		expect(dead).toEqual([]);
	});

	test("no `--no-x` option carries a default value", () => {
		// The other half of the same bug, and the trap in the obvious fix: with
		// `.option("--no-estimate", "...", false)`, commander stores `false` by
		// DEFAULT, so a reader testing `estimate === false` filters on every run —
		// turning an opt-in flag into permanently-on behaviour.
		const withDefaults = SURFACE.filter(
			(row) => row.long.startsWith("--no-") && row.option.defaultValue !== undefined,
		).map((row) => `${key(row)} (default ${String(row.option.defaultValue)})`);
		expect(withDefaults).toEqual([]);
	});

	test("every option is exercised by a test, or explicitly listed as not yet", () => {
		// "Exercised" means a test passes the FLAG through an argv array or the
		// ATTRIBUTE into an action-level entry point. A `--help` assertion is
		// neither; that is exactly the assertion that let the no-op ship.
		const unexercised: string[] = [];
		for (const row of SURFACE) {
			// Short form counts: `-o exports/board.md` exercises `--output`.
			const forms = [row.long, row.option.short].filter((form): form is string => Boolean(form));
			const argv = new RegExp(`\\[[^\\]]*["'](?:${forms.join("|")})["']`, "s");
			// An action-level object key counts ONLY in a file that also names the
			// command. Without that, `\bestimate\s*:` matched YAML `estimate: 3` in
			// a serializer test, `concurrency:` matched a fake client's property, and
			// 46 of 251 options were reported covered by tests that never invoke
			// them. The backlog being empty was a claim about the suite, and it was
			// false.
			const leaf = row.command.split(" ").at(-1) as string;
			const namesCommand = new RegExp(`["'\`/]${leaf}\\b`);
			const asObjectKey = new RegExp(`\\b${row.attribute}\\s*:`);
			const covered = TESTS.some(
				(file) =>
					(forms.some((form) => file.text.includes(`"${form}"`)) && argv.test(file.text)) ||
					(asObjectKey.test(file.text) && namesCommand.test(file.text)),
			);
			if (!covered) unexercised.push(key(row));
		}

		const undeclared = unexercised.filter((entry) => !(entry in UNEXERCISED_BACKLOG));
		expect(undeclared).toEqual([]);

		// And the backlog may not rot: an entry that IS covered now must be deleted,
		// so the list stays an accurate statement about the suite.
		const staleEntries = Object.keys(UNEXERCISED_BACKLOG).filter(
			(entry) => !unexercised.includes(entry),
		);
		expect(staleEntries).toEqual([]);
	});

	test("commander maps every `--no-x` flag the way the reading code assumes", () => {
		// Absent -> true, passed -> false. Every `--no-*` consumer in this codebase
		// is written against that mapping (`!options.writeBack`,
		// `options.failOnFindings !== false`, `options.estimate === false`), so if
		// commander ever changed it, all of them would invert at once and silently.
		// Measured against the library rather than assumed from its docs.
		for (const row of SURFACE.filter((candidate) => candidate.long.startsWith("--no-"))) {
			const parse = (argv: string[]): Record<string, unknown> => {
				const probe = new Command();
				probe.exitOverride();
				const sub = probe.command("probe");
				sub.addOption(row.option);
				sub.action(() => {});
				probe.parse(["node", "x", "probe", ...argv]);
				return sub.opts();
			};
			expect(parse([])[row.attribute]).toBe(true);
			expect(parse([row.long])[row.attribute]).toBe(false);
		}
	});

	test("every registered command is invoked by at least one test", () => {
		// A command nobody runs is the same defect one level up.
		const commands = [...new Set(SURFACE.map((row) => row.command))].filter(
			(name) => name !== "planestories",
		);
		const never = commands.filter((name) => {
			const leaf = name.split(" ").at(-1) as string;
			// Two honest signals: the name passed through an argv array, or a test
			// importing the module that registers it. Matching the bare word would
			// pass on any incidental mention — the weak-assertion trap again.
			const inArgv = new RegExp(`\\[[^\\]]*["']${leaf}["']`, "s");
			const owner = SOURCES.find((file) => file.text.includes(`.command("${leaf}`));
			const importsOwner = owner
				? new RegExp(
						`from\\s+["'][^"']*${owner.path.split("/").at(-1)?.replace(".ts", "")}\\.ts["']`,
					)
				: null;
			return !TESTS.some(
				(file) => inArgv.test(file.text) || (importsOwner?.test(file.text) ?? false),
			);
		});
		expect(never.filter((name) => !(name in UNINVOKED_COMMAND_BACKLOG))).toEqual([]);
		expect(Object.keys(UNINVOKED_COMMAND_BACKLOG).filter((name) => !never.includes(name))).toEqual(
			[],
		);
	});
});
