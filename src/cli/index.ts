#!/usr/bin/env bun
import { Command } from "commander";
import { registerAtlasCommand } from "./commands/atlas.ts";
import { registerCapabilitiesCommand } from "./commands/capabilities.ts";
import { registerCriticalPathCommand } from "./commands/critical-path.ts";
import { registerDeleteCommand } from "./commands/delete.ts";
import { registerDiffCommand } from "./commands/diff.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerEpicCommand } from "./commands/epic.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerGroomCommand } from "./commands/groom.ts";
import { registerImportCommand } from "./commands/import.ts";
import { registerLintCommand } from "./commands/lint.ts";
import { registerMigrateCriteriaCommand } from "./commands/migrate.ts";
import { registerPacketCommand } from "./commands/packet.ts";
import { registerProjectsCommand } from "./commands/projects.ts";
import { registerRenameProjectCommand } from "./commands/rename-project.ts";
import { registerReplicateCommand } from "./commands/replicate.ts";
import { registerSetCommand } from "./commands/set.ts";
import { registerTrendCommand } from "./commands/trend.ts";
import { armLingerNotice } from "./flush.ts";

const program = new Command();

program
	.name("planestories")
	.description("Bridge markdown user stories and Plane work items")
	.version("0.5.0")
	// Options bind to the command they FOLLOW. Required so `replicate` can carry
	// its own one-shot options while its snapshot/apply subcommands own theirs
	// (a parent would otherwise consume `-p`/`-o` before the subcommand parses).
	.enablePositionalOptions();

registerImportCommand(program);
registerCapabilitiesCommand(program);
registerExportCommand(program);
registerDeleteCommand(program);
registerSetCommand(program);
registerProjectsCommand(program);
registerGroomCommand(program);
registerMigrateCriteriaCommand(program);
registerDoctorCommand(program);
registerAtlasCommand(program);
registerLintCommand(program);
registerPacketCommand(program);
registerEpicCommand(program);
registerCriticalPathCommand(program);
registerDiffCommand(program);
registerTrendCommand(program);
registerReplicateCommand(program);
registerRenameProjectCommand(program);

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
