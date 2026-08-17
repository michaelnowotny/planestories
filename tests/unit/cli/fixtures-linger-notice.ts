import { armLingerNotice } from "../../../src/cli/flush.ts";

// A ref'd timer stands in for the lingering handle, so the notice actually fires.
if (process.argv[3] === "tty") {
	// Stand in for a terminal so the TTY branch is exercised without one.
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
}
const keepAlive = setTimeout(() => {}, 2_000);
armLingerNotice(50, process.argv[2] !== "fail");
setTimeout(() => clearTimeout(keepAlive), 300);
