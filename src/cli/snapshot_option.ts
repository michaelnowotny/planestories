import chalk from "chalk";
import type { PlaneClient } from "../plane/client.ts";
import { parseSnapshot } from "../replicate/snapshot.ts";
import { SnapshotSource } from "../replicate/snapshot_source.ts";

/**
 * Shared plumbing for `--from-snapshot` on the read-only commands.
 *
 * A snapshot contains exactly what these commands enumerate, so it can stand in for
 * the instance entirely: zero API calls, offline, and possible when the instance is
 * rate-limiting you. The one rule every consumer must honour — and the reason this
 * lives in one place rather than being copy-pasted — is that a command reading a
 * snapshot must SAY SO and print the snapshot's age. A stale answer presented as a
 * live one is worse than no answer.
 */
export async function openSnapshotSource(file: string): Promise<SnapshotSource> {
	const handle = Bun.file(file);
	if (!(await handle.exists())) throw new Error(`Snapshot file not found: ${file}`);
	return new SnapshotSource(parseSnapshot(await handle.text()));
}

/** Announce provenance on stderr, so `--json` stdout stays machine-clean. */
export function announceSnapshotSource(source: SnapshotSource, json: boolean): void {
	if (json) return;
	console.error(chalk.dim(source.provenance()));
}

/** The narrow cast every command needs; the source implements the read surface they use. */
export function asClient(source: SnapshotSource): PlaneClient {
	return source as unknown as PlaneClient;
}

export const FROM_SNAPSHOT_HELP =
	"Read a snapshot file instead of the live board: ZERO API calls, works offline, and possible when the instance is rate-limiting you. Output states the snapshot's age.";
