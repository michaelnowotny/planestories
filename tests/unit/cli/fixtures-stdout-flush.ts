import { armLingerNotice } from "../../../src/cli/flush.ts";

process.stdout.write("x".repeat(1024 * 1024));
// A deliberately short interval: if this ever force-exits again, the delayed-reader
// test below will see a truncated payload.
armLingerNotice(200);
