import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAllCommands } from "../../../src/cli/register_all.ts";

const README = await Bun.file(new URL("../../../README.md", import.meta.url)).text();
const CHEATSHEET = await Bun.file(new URL("../../../docs/CHEATSHEET.md", import.meta.url)).text();

function registeredCommands(): string[] {
	const program = new Command();
	program.exitOverride();
	registerAllCommands(program);
	return program.commands.map((command) => command.name()).sort();
}

function registeredSubcommands(): string[] {
	const program = new Command();
	program.exitOverride();
	registerAllCommands(program);
	return program.commands
		.flatMap((parent) => parent.commands.map((command) => `${parent.name()} ${command.name()}`))
		.sort();
}

describe("public documentation surface", () => {
	test("README and cheatsheet demonstrate every registered top-level command", () => {
		for (const [name, document] of [
			["README.md", README],
			["docs/CHEATSHEET.md", CHEATSHEET],
		] as const) {
			const missing = registeredCommands().filter(
				(command) => !document.includes(`planestories ${command}`),
			);
			expect(missing, `${name} is missing registered commands`).toEqual([]);
		}
	});

	test("README and cheatsheet demonstrate every registered nested command", () => {
		for (const [name, document] of [
			["README.md", README],
			["docs/CHEATSHEET.md", CHEATSHEET],
		] as const) {
			const missing = registeredSubcommands().filter(
				(command) => !document.includes(`planestories ${command}`),
			);
			expect(missing, `${name} is missing registered nested commands`).toEqual([]);
		}
	});

	test("README quick start teaches the current story-quality contract", () => {
		const quickStartStory = README.slice(
			README.indexOf("### 4. Write your first story"),
			README.indexOf("### 5. Import"),
		);
		expect(quickStartStory).toContain("**Outcome:**");
		expect(quickStartStory).toContain("**Effort:**");
	});

	test("README marks sub-item criteria sync as legacy", () => {
		expect(README).toContain("**Deprecated:** `--sync-criteria`");
		expect(README).toContain("planestories migrate-criteria");
	});

	test("public examples preserve the data-placement and local-config safety rules", () => {
		const publicDocs = `${README}\n${CHEATSHEET}`;
		for (const staleExample of [
			"-o g.json",
			"-o data.snapshot.json",
			"--dir backups",
			".planestoriesrc.json — committed",
		]) {
			expect(publicDocs).not.toContain(staleExample);
		}
	});

	test("public docs do not restore the audited 0.6 overclaims", () => {
		const publicDocs = `${README}\n${CHEATSHEET}`;
		expect(publicDocs).not.toContain("Every Plane API call retries");
		expect(publicDocs).not.toContain("ships a Claude Code skill");
		expect(publicDocs).not.toContain("offline, 10 mechanical rules");
	});
});
