/**
 * The ONE place every command is registered.
 *
 * Extracted from `index.ts` so a test can build the REAL program — the same
 * surface the binary exposes — without importing the entrypoint, which parses
 * argv the moment it loads. The CLI-surface invariants in
 * `tests/unit/cli/surface-invariants.test.ts` depend on this being the single
 * source of truth: a command registered only in `index.ts` would be invisible
 * to them, which defeats the point of checking the whole surface.
 */
import type { Command } from "commander";
import { registerAtlasCommand } from "./commands/atlas.ts";
import { registerAuditCommand } from "./commands/audit.ts";
import { registerBoardCommand } from "./commands/board.ts";
import { registerCapabilitiesCommand } from "./commands/capabilities.ts";
import { registerCriticalPathCommand } from "./commands/critical-path.ts";
import { registerDeleteCommand } from "./commands/delete.ts";
import { registerDiffCommand } from "./commands/diff.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerEpicCommand } from "./commands/epic.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerGraphQueryCommands } from "./commands/graph-queries.ts";
import { registerGroomCommand } from "./commands/groom.ts";
import { registerImportCommand } from "./commands/import.ts";
import { registerLintCommand } from "./commands/lint.ts";
import { registerMigrateCriteriaCommand } from "./commands/migrate.ts";
import { registerPacketCommand } from "./commands/packet.ts";
import { registerProjectsCommand } from "./commands/projects.ts";
import { registerCountCommand, registerLsCommand } from "./commands/query.ts";
import { registerRenameProjectCommand } from "./commands/rename-project.ts";
import { registerReplicateCommand } from "./commands/replicate.ts";
import { registerSetCommand } from "./commands/set.ts";
import { registerShowCommand } from "./commands/show.ts";
import { registerTrendCommand } from "./commands/trend.ts";

export function registerAllCommands(program: Command): void {
	registerImportCommand(program);
	registerCapabilitiesCommand(program);
	registerExportCommand(program);
	registerDeleteCommand(program);
	registerSetCommand(program);
	registerProjectsCommand(program);
	registerGroomCommand(program);
	registerMigrateCriteriaCommand(program);
	registerDoctorCommand(program);
	registerBoardCommand(program);
	registerAuditCommand(program);
	registerAtlasCommand(program);
	registerShowCommand(program);
	registerGraphQueryCommands(program);
	registerLsCommand(program);
	registerCountCommand(program);
	registerLintCommand(program);
	registerPacketCommand(program);
	registerEpicCommand(program);
	registerCriticalPathCommand(program);
	registerDiffCommand(program);
	registerTrendCommand(program);
	registerReplicateCommand(program);
	registerRenameProjectCommand(program);
}
