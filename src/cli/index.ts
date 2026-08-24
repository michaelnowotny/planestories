#!/usr/bin/env bun
import { Command } from "commander";
import { armLingerNotice } from "./flush.ts";
import { registerAllCommands } from "./register_all.ts";

const program = new Command();

program
	.name("planestories")
	.description("Bridge markdown user stories and Plane work items")
	.version("0.6.0")
	// Options bind to the command they FOLLOW. Required so `replicate` can carry
	// its own one-shot options while its snapshot/apply subcommands own theirs
	// (a parent would otherwise consume `-p`/`-o` before the subcommand parses).
	.enablePositionalOptions();

registerAllCommands(program);

// Long runs were observed idling for ~45 MINUTES after their final output, because a
// lingering keep-alive socket keeps the runtime alive long after every write has been
// awaited. That made "finished" indistinguishable from "hung" and nearly cost a user a
// completed migration. Do not force an exit once the command's work is done, preserving
// whatever exit code the command set.
program
	.parseAsync()
	.then(() => {
		// Deliberately NOT process.exit(): forcing an exit truncates piped stdout and
		// cannot be made safe on this runtime (see src/cli/flush.ts). Natural shutdown
		// delivers output in full; the notice only tells the truth if it is slow.
		armLingerNotice();
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		armLingerNotice(undefined, false);
	});
