/**
 * Exit discipline.
 *
 * Two failure modes pull in opposite directions:
 *
 *   1. A run can finish its work and then sit for ~45 MINUTES on some lingering
 *      handle, making "finished" indistinguishable from "hung" (a user nearly killed
 *      a completed migration over it).
 *   2. `process.exit()` DISCARDS buffered stdout. Measured in Bun: a 1 MiB payload
 *      through a pipe arrives as exactly 65,536 bytes — the pipe buffer — and no
 *      flush strategy prevents it (`write("", cb)` and polling `writableLength` both
 *      still truncate). Losing the tail of an epic `packet` or a JSON artifact is a
 *      silent data loss.
 *
 * So: never force an exit on the happy path — let the runtime end naturally, which
 * delivers stdout in full and, when nothing lingers, is immediate anyway. Arm an
 * UNREF'd watchdog instead: it cannot hold the process open by itself, so a healthy
 * run still exits at once, but if something else is holding the loop it fires and
 * ends the run deliberately — refusing to do so while stdout still has bytes waiting,
 * because a slow reader must not be truncated either.
 */
const WATCHDOG_MS = 5_000;

export function armExitWatchdog(intervalMs: number = WATCHDOG_MS): void {
	const schedule = () => {
		const timer = setTimeout(() => {
			const pending = (process.stdout as { writableLength?: number }).writableLength ?? 0;
			if (pending > 0) {
				// A slow consumer is still reading. Wait rather than truncate it.
				schedule();
				return;
			}
			console.error(
				"planestories: work finished but the runtime is still alive (a lingering connection handle); exiting.",
			);
			process.exit(process.exitCode ?? 0);
		}, intervalMs);
		timer.unref?.();
	};
	schedule();
}
