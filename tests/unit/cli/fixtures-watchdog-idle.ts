import { armLingerNotice } from "../../../src/cli/flush.ts";

process.stdout.write("done\n");
// 60s: if this were ref'd, the process would sit for a minute.
armLingerNotice(60_000);
