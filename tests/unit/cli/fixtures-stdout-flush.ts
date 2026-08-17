import { armExitWatchdog } from "../../../src/cli/flush.ts";

process.stdout.write("x".repeat(1024 * 1024));
armExitWatchdog();
