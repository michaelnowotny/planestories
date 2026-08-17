import { armLingerNotice } from "../../../src/cli/flush.ts";

// A ref'd timer stands in for the lingering handle, so the notice actually fires.
const keepAlive = setTimeout(() => {}, 2_000);
armLingerNotice(50, process.argv[2] !== "fail");
setTimeout(() => clearTimeout(keepAlive), 300);
