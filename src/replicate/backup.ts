import { existsSync } from "node:fs";
import { link, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ReplicateError } from "../errors.ts";
import { checkFreshness, type FreshnessClient, formatFreshnessReport } from "./freshness.ts";
import { type SnapshotClient, serializeSnapshot, takeSnapshot } from "./snapshot.ts";

export interface BackupOptions {
	dir: string;
	retain: number;
	toolVersion: string;
	concurrency?: number;
	checkFresh: boolean;
	now?: () => Date;
	onProgress?: (message: string) => void;
}

export interface BackupResult {
	file: string;
	digest: string;
	items: number;
	archived: number;
	fresh: boolean | null;
	freshnessNotes: string[];
	pruned: string[];
	kept: number;
}

/**
 * A short, filesystem-safe tag identifying the SOURCE instance of a backup, so
 * backups of two boards that share a project identifier never collide and never
 * prune one another.
 */
export function instanceTag(baseUrl: string, workspaceSlug: string): string {
	const host = (() => {
		try {
			return new URL(baseUrl).hostname;
		} catch {
			return baseUrl;
		}
	})();
	// Use the whole host, not its first label: "api.plane.so" and
	// "plane.porcupine.works" both start with "plane", and collapsing them would
	// recreate the cross-instance prune collision this tag exists to prevent
	// whenever two instances share a workspace slug.
	return `${host.replace(/^api\./, "")}-${workspaceSlug}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-");
}

export async function runBackup(
	client: SnapshotClient & FreshnessClient,
	projectRef: { projectId: string },
	options: BackupOptions,
): Promise<BackupResult> {
	if (!Number.isInteger(options.retain) || options.retain < 1) {
		throw new ReplicateError(`retain must be a positive integer, got "${options.retain}"`);
	}

	const now = options.now ?? (() => new Date());
	const instant = now();
	if (Number.isNaN(instant.getTime()))
		throw new ReplicateError("Backup clock returned an invalid date");
	const snapshot = await takeSnapshot(client, projectRef, {
		toolVersion: options.toolVersion,
		concurrency: options.concurrency,
		now: () => instant.toISOString(),
		onProgress: options.onProgress,
	});
	const identifier = snapshot.project.identifier.toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(identifier)) {
		throw new ReplicateError(
			`Snapshot project identifier is unsafe for a backup filename: "${snapshot.project.identifier}"`,
		);
	}
	// Two boards can share a project identifier (a cutover leaves the old instance
	// holding the same one), so an identifier-only filename lets a mis-pointed cron
	// prune the OTHER board's history — the rollback copy — under its retention rule.
	// Tag the source instance into the name. Directory separation then stops being
	// the only thing standing between you and losing a rollback.
	const sourceTag = instanceTag(snapshot.source.baseUrl, snapshot.source.workspaceSlug);
	const stamp = instant
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")
		.replace("T", "-");
	const directory = resolve(options.dir);
	const file = resolve(directory, `${identifier}.${sourceTag}.${stamp}.snapshot.json`);
	if (dirname(file) !== directory) {
		throw new ReplicateError(
			`Backup file must remain inside its directory; refusing identifier "${snapshot.project.identifier}"`,
		);
	}
	if (existsSync(file)) {
		throw new ReplicateError(`Backup file already exists: ${file}; refusing to overwrite it`);
	}

	await mkdir(directory, { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		await writeFile(temporary, serializeSnapshot(snapshot), { flag: "wx" });
		await link(temporary, file);
		await unlink(temporary);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new ReplicateError(`Backup file already exists: ${file}; refusing to overwrite it`);
		}
		throw error;
	}

	let fresh: boolean | null = null;
	let freshnessNotes: string[] = [];
	if (options.checkFresh) {
		const report = await checkFreshness(client, snapshot);
		fresh = report.fresh;
		freshnessNotes = report.fresh
			? [...report.notes]
			: formatFreshnessReport(report)
					.split("\n")
					.filter((line) => !line.startsWith("Note: "))
					.concat(report.notes);
	}

	const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedTag = sourceTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Retention prunes ONLY this identifier from THIS source: a file from the other
	// instance must be invisible to this rule even in a shared directory. Legacy
	// untagged files (written before this change) are also left alone rather than
	// silently swept.
	const pattern = new RegExp(
		`^${escapedIdentifier}\\.${escapedTag}\\.\\d{8}-\\d{6}Z\\.snapshot\\.json$`,
	);
	const matching = (await readdir(directory))
		.filter((name) => pattern.test(name))
		.sort((a, b) => b.localeCompare(a));
	const toPrune = matching.slice(options.retain);
	const pruned: string[] = [];
	const failures: string[] = [];
	for (const name of toPrune) {
		const target = resolve(directory, name);
		try {
			await unlink(target);
			pruned.push(target);
		} catch (error) {
			failures.push(
				`${basename(target)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (failures.length > 0) {
		throw new ReplicateError(
			`Backup succeeded and was written to ${file}, but retention failed for ${failures.length} file(s): ${failures.join("; ")}`,
		);
	}

	return {
		file,
		digest: snapshot.digest,
		items: snapshot.items.length,
		archived: snapshot.items.filter((item) => item.archived).length,
		fresh,
		freshnessNotes,
		pruned,
		kept: matching.length - pruned.length,
	};
}
