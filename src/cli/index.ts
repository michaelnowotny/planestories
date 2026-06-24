#!/usr/bin/env bun
import { Command } from "commander";
import { registerDeleteCommand } from "./commands/delete.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerImportCommand } from "./commands/import.ts";
import { registerSetCommand } from "./commands/set.ts";

const program = new Command();

program
	.name("planestories")
	.description("Bridge markdown user stories and Plane work items")
	.version("0.1.0");

registerImportCommand(program);
registerExportCommand(program);
registerDeleteCommand(program);
registerSetCommand(program);

program.parse();
