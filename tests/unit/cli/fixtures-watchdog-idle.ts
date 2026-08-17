import { armExitWatchdog } from "../../../src/cli/flush.ts";

process.stdout.write("done\n");
// A 60s interval: if the watchdog were ref'd, this process would take a minute.
armExitWatchdog(60_000);
