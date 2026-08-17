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

/**
 * @param intervalMs how long to wait before saying anything
 * @param succeeded  false when the command threw — a failed run must NOT be described
 *                   as complete
 */
export function armLingerNotice(intervalMs: number = NOTICE_MS, succeeded = true): void {
	const timer = setTimeout(() => {
		// What is safe depends on where stdout goes, and saying otherwise is the kind
		// of confident-but-wrong line this tool exists not to print:
		//   - on a TTY there is no unread pipe, so the linger really is just a
		//     connection handle and interrupting costs nothing;
		//   - on a PIPE the runtime may be alive precisely BECAUSE the consumer has
		//     not finished reading, so interrupting would truncate that output.
		// Describe the situation; do not issue an imperative we cannot justify.
		const what = succeeded
			? "the command has returned (its work is finished); the runtime has not exited"
			: "the command has failed and returned; the runtime has not exited";
		const detail = process.stdout.isTTY
			? "It is waiting on a lingering connection handle — interrupting is safe."
			: "It may be waiting on a lingering connection handle, or on whatever is reading its output — interrupting could truncate that output.";
		console.error(`planestories: ${what}. ${detail}`);
	}, intervalMs);
	// Unref'd: it must never keep the process alive by itself, or every command would
	// pay this interval.
	timer.unref?.();
}
