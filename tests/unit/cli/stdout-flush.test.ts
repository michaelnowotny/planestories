import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Regression, three rounds in the making. The CLI must never force an exit:
 * `process.exit()` discards buffered stdout (measured: 1 MiB through a pipe arrives as
 * 65,536 bytes), it cannot be made safe by draining (Bun reports `writableLength` as 0
 * always), and unread stdout is itself what keeps the loop alive — so a watchdog that
 * exits on "still alive" truncates precisely the slow reader it must protect.
 */
test("a large payload survives a DELAYED pipe reader", async () => {
	const script = join(import.meta.dir, "fixtures-stdout-flush.ts");
	// A REAL shell pipeline with a sleeping reader. Bun.spawn drains the child
	// concurrently, which hides the very condition under test: an OS pipe whose
	// 64 KiB buffer is full while nobody is reading yet. Measured directly, that
	// case truncates 1 MiB to 65,536 bytes under a forced exit.
	const proc = Bun.spawn(
		["sh", "-c", `bun run ${JSON.stringify(script)} | (sleep 1; cat) | wc -c`],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const out = (await new Response(proc.stdout).text()).trim();
	await proc.exited;
	expect(Number(out)).toBe(1024 * 1024);
});

test("a healthy run still exits promptly (the notice is unref'd)", async () => {
	const script = join(import.meta.dir, "fixtures-watchdog-idle.ts");
	const started = performance.now();
	const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe" });
	await new Response(proc.stdout).text();
	await proc.exited;
	expect(performance.now() - started).toBeLessThan(3000);
});
