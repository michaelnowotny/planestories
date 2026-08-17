import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Regression: the CLI exits deliberately (a lingering keep-alive handle otherwise kept
 * runs alive for ~45 minutes after their work finished). `process.exit` discards
 * buffered stdout, so on a PIPE a large payload — an epic `packet`, `atlas --json` —
 * would lose its tail silently. Anything that exits must drain first.
 */
test("a large payload survives process.exit when stdout is a pipe", async () => {
	const script = join(import.meta.dir, "fixtures-stdout-flush.ts");
	const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	// 1 MiB: comfortably past a 64 KiB pipe buffer, so an undrained exit truncates.
	expect(text.length).toBe(1024 * 1024);
});

test("the watchdog does not delay a healthy run (it is unref'd)", async () => {
	// If the watchdog held the loop open, every command would pay its interval.
	const script = join(import.meta.dir, "fixtures-watchdog-idle.ts");
	const started = performance.now();
	const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe" });
	await new Response(proc.stdout).text();
	await proc.exited;
	expect(performance.now() - started).toBeLessThan(3000);
});
