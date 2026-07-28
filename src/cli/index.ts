#!/usr/bin/env bun
import { Command } from "commander";
import { registerAtlasCommand } from "./commands/atlas.ts";
import { registerDeleteCommand } from "./commands/delete.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerGroomCommand } from "./commands/groom.ts";
import { registerImportCommand } from "./commands/import.ts";
import { registerLintCommand } from "./commands/lint.ts";
import { registerPacketCommand } from "./commands/packet.ts";
import { registerProjectsCommand } from "./commands/projects.ts";
import { registerSetCommand } from "./commands/set.ts";

const program = new Command();

program
	.name("planestories")
	.description("Bridge markdown user stories and Plane work items")
	.version("0.3.1");

registerImportCommand(program);
registerExportCommand(program);
registerDeleteCommand(program);
registerSetCommand(program);
registerProjectsCommand(program);
registerGroomCommand(program);
registerDoctorCommand(program);
registerAtlasCommand(program);
registerLintCommand(program);
registerPacketCommand(program);

program.parse();
