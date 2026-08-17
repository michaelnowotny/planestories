/**
 * Why this file does NOT force an exit.
 *
 * The symptom that started this: a run finished its work and then sat for ~45 MINUTES
 * on a lingering handle, so "finished" was indistinguishable from "hung" and a user
 * nearly killed a completed migration.
 *
 * The obvious fix — `process.exit()` once the command returns — is unsafe here, and
 * measurably so on this runtime:
 *
 *   - `process.exit()` DISCARDS buffered stdout. A 1 MiB payload through a pipe
 *     arrives as exactly 65,536 bytes (the pipe buffer).
 *   - It cannot be made safe by draining first: `process.stdout.write("", cb)` and
 *     polling `process.stdout.writableLength` both still truncate, and on Bun
 *     `writableLength` is ALWAYS 0, so any guard built on it is dead code.
 *   - Worse, UNREAD stdout is itself a handle keeping the loop alive. So "something
 *     is lingering" and "the consumer has not read my output yet" are the same
 *     observation from inside the process — and a watchdog that exits on the first
 *     cannot avoid killing the second. A slow or late pipe reader
 *     (`| less`, a CI capture, `packet`/`atlas --json`/`export` piped to a file)
 *     is exactly what gets truncated.
 *
 * Since we cannot distinguish the two cases, we do not gamble with the user's data:
 * the process ends naturally, which delivers stdout in full and, when nothing
 * lingers, is immediate anyway (a client run exits in ~0.75 s).
 *
 * What we CAN do honestly is tell the truth: if the runtime is still alive well after
 * the work finished, say so once on stderr. The user then knows the command is done —
 * which was the actual harm — and that interrupting it is safe, because every write is
 * awaited before a command returns.
 */
const NOTICE_MS = 5_000;

export function armLingerNotice(intervalMs: number = NOTICE_MS): void {
	const timer = setTimeout(() => {
		console.error(
			"planestories: the work above is COMPLETE — the process is only waiting on a lingering connection handle (or on a reader of its output). Interrupting now is safe.",
		);
	}, intervalMs);
	// Unref'd: it must never keep the process alive by itself, or every command would
	// pay this interval.
	timer.unref?.();
}
