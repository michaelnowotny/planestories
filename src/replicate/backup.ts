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
	const stamp = instant
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")
		.replace("T", "-");
	const directory = resolve(options.dir);
	const file = resolve(directory, `${identifier}.${stamp}.snapshot.json`);
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
	const pattern = new RegExp(`^${escapedIdentifier}\\.\\d{8}-\\d{6}Z\\.snapshot\\.json$`);
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
