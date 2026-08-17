import chalk from "chalk";
import { loadConfig } from "../config/loader.ts";
import type { PlaneClient } from "../plane/client.ts";
import { parseSnapshot } from "../replicate/snapshot.ts";
import { SnapshotSource } from "../replicate/snapshot_source.ts";
import type { ResolvedConfig } from "../types.ts";

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

/**
 * Announce provenance on stderr — ALWAYS, including in `--json` mode. stderr does not
 * pollute a machine-readable stdout, and a human running `--json` in a terminal should
 * still be told the data is from a file and how old it is. The payload carries the same
 * fact in `source` for anything reading the artifact later.
 */
export function announceSnapshotSource(source: SnapshotSource, _json = false): void {
	console.error(chalk.dim(source.provenance()));
}

/** The narrow cast every command needs; the source implements the read surface they use. */
export function asClient(source: SnapshotSource): PlaneClient {
	return source as unknown as PlaneClient;
}

export const FROM_SNAPSHOT_HELP =
	"Read a snapshot file instead of the live board: ZERO API calls, works offline, and possible when the instance is rate-limiting you. Output states the snapshot's age.";

/**
 * The provenance field embedded in machine-readable output. It lives here, and is
 * tested through the actual command, because a stored `--json` artifact that omits it
 * is indistinguishable from a live reading — and a test that merely passes this object
 * through a helper would not notice if a command stopped calling it.
 */
export function snapshotProvenance(source: SnapshotSource | null): {
	source?: { kind: "snapshot"; takenAt: string };
} {
	return source ? { source: { kind: "snapshot", takenAt: source.takenAt } } : {};
}

/**
 * Config loading for a snapshot-backed run.
 *
 * `--from-snapshot` advertises that it works OFFLINE, so reading a file must not
 * require credentials — every command loads config before it reads the snapshot, and
 * `loadConfig` otherwise refuses to start without an API key.
 *
 * This does NOT swallow config errors. Only the two secret assertions are skipped; a
 * present config file is fully resolved (so `defaultProject` and friends still apply),
 * and a malformed `.planestoriesrc.json` or a bad `--config` path still fails loudly —
 * those are things the user wants to hear about, and hiding them would be the same
 * silent-fallback habit this tool exists to avoid.
 */
export async function loadConfigForSnapshot(
	configPath: string | undefined,
	context: string | undefined,
): Promise<ResolvedConfig> {
	return loadConfig({ configPath, context, requireCredentials: false });
}
