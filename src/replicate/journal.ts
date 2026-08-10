import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { ReplicateError } from "../errors.ts";
import type { TargetProbeResult } from "./probe.ts";
import type { IdentifierMode } from "./types.ts";

export interface JournalHeader {
	type: "header";
	runId: string;
	createdAt: string;
	toolVersion: string;
	snapshotDigest: string;
	target: { baseUrl: string; workspaceSlug: string };
	destName: string;
	destIdentifier: string;
	identifierMode: IdentifierMode;
}

export type JournalEntry =
	| JournalHeader
	| { type: "probe"; probe: TargetProbeResult }
	| { type: "project-created"; projectId: string; identifier: string; name: string }
	| {
			type: "state-mapped";
			sourceStateId: string;
			targetStateId: string;
			action: "matched" | "created" | "patched";
	  }
	| { type: "label-mapped"; sourceLabelId: string; targetLabelId: string; action: "created" }
	| { type: "item-intent"; seq: number; sourceItemId: string | null }
	| { type: "item-created"; seq: number; sourceItemId: string | null; targetItemId: string }
	| { type: "item-archived"; targetItemId: string }
	| { type: "parent-set"; targetItemId: string }
	| { type: "relation-created"; key: string }
	| { type: "comment-intent"; sourceCommentId: string; sourceItemId: string }
	| { type: "comment-created"; sourceCommentId: string; targetCommentId: string }
	| { type: "cleanup-started" }
	| { type: "placeholder-deleted"; targetItemId: string; seq: number }
	| { type: "poisoned"; reason: string }
	| { type: "apply-complete" };

export interface JournalExpectedBinding {
	snapshotDigest: string;
	targetBaseUrl: string;
	targetWorkspaceSlug: string;
}

export interface JournalOptions {
	warn?: (message: string) => void;
}

type JournalOptionInput = JournalOptions | ((message: string) => void);

/**
 * Append-only crash ledger for replication. Each fact reaches stable storage
 * before its caller can perform the next irreversible operation.
 */
export class Journal {
	readonly path: string;
	readonly entries: JournalEntry[];
	readonly header: JournalHeader;
	private readonly fd: number;
	private readonly lockPath: string;
	private closed = false;

	private constructor(path: string, fd: number, entries: JournalEntry[], lockPath: string) {
		const header = entries[0];
		if (!header || header.type !== "header") {
			throw new ReplicateError(`Journal ${path} has no header`);
		}
		this.path = path;
		this.fd = fd;
		this.entries = entries;
		this.header = header;
		this.lockPath = lockPath;
	}

	static create(path: string, header: JournalHeader, options: JournalOptionInput = {}): Journal {
		const lockPath = acquireLock(path, warningCallback(options));
		try {
			if (existsSync(path)) {
				throw new ReplicateError(`Journal already exists: ${path}`);
			}
			const fd = openSync(path, "a");
			writeSync(fd, `${JSON.stringify(header)}\n`);
			fsyncSync(fd);
			return new Journal(path, fd, [header], lockPath);
		} catch (error) {
			releaseLock(lockPath);
			throw error;
		}
	}

	static open(
		path: string,
		expected: JournalExpectedBinding,
		options: JournalOptionInput = {},
	): Journal {
		const lockPath = acquireLock(path, warningCallback(options));
		try {
			if (!existsSync(path)) {
				throw new ReplicateError(`Journal does not exist: ${path}`);
			}
			const entries = parseJournal(path);
			const header = entries[0];
			if (!header || header.type !== "header") {
				throw new ReplicateError(`Journal ${path} has no valid header`);
			}
			validateBinding(header, expected);
			const fd = openSync(path, "a");
			return new Journal(path, fd, entries, lockPath);
		} catch (error) {
			releaseLock(lockPath);
			throw error;
		}
	}

	append(entry: JournalEntry): void {
		if (this.closed) {
			throw new ReplicateError(`Cannot append to closed journal ${this.path}`);
		}
		writeSync(this.fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(this.fd);
		this.entries.push(entry);
	}

	get createdBySeq(): Map<number, { targetItemId: string; sourceItemId: string | null }> {
		const out = new Map<number, { targetItemId: string; sourceItemId: string | null }>();
		for (const entry of this.entries) {
			if (entry.type === "item-created") {
				out.set(entry.seq, {
					targetItemId: entry.targetItemId,
					sourceItemId: entry.sourceItemId,
				});
			}
		}
		return out;
	}

	pendingIntent(seq: number): Extract<JournalEntry, { type: "item-intent" }> | null {
		const created = this.createdBySeq.get(seq);
		if (created) return null;
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry?.type === "item-intent" && entry.seq === seq) return entry;
		}
		return null;
	}

	get isPoisoned(): boolean {
		return this.entries.some((entry) => entry.type === "poisoned");
	}

	get cleanupStarted(): boolean {
		return this.entries.some((entry) => entry.type === "cleanup-started");
	}

	get isComplete(): boolean {
		return this.entries.some((entry) => entry.type === "apply-complete");
	}

	placeholders(): Array<{ seq: number; targetItemId: string }> {
		return this.entries
			.filter(
				(entry): entry is Extract<JournalEntry, { type: "item-created" }> =>
					entry.type === "item-created" && entry.sourceItemId === null,
			)
			.map((entry) => ({ seq: entry.seq, targetItemId: entry.targetItemId }));
	}

	get projectCreated(): Extract<JournalEntry, { type: "project-created" }> | null {
		return (
			this.entries.find(
				(entry): entry is Extract<JournalEntry, { type: "project-created" }> =>
					entry.type === "project-created",
			) ?? null
		);
	}

	get probeEntry(): Extract<JournalEntry, { type: "probe" }> | null {
		return (
			this.entries.find(
				(value): value is Extract<JournalEntry, { type: "probe" }> => value.type === "probe",
			) ?? null
		);
	}

	get parentSet(): Set<string> {
		return new Set(
			this.entries
				.filter((entry) => entry.type === "parent-set")
				.map((entry) => entry.targetItemId),
		);
	}

	get relationKeys(): Set<string> {
		return new Set(
			this.entries.filter((entry) => entry.type === "relation-created").map((entry) => entry.key),
		);
	}

	get commentsCreated(): Set<string> {
		return new Set(
			this.entries
				.filter((entry) => entry.type === "comment-created")
				.map((entry) => entry.sourceCommentId),
		);
	}

	get commentIntents(): Array<Extract<JournalEntry, { type: "comment-intent" }>> {
		return this.entries.filter(
			(entry): entry is Extract<JournalEntry, { type: "comment-intent" }> =>
				entry.type === "comment-intent",
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeSync(this.fd);
		releaseLock(this.lockPath);
	}

	/** Close and move a poisoned generation out of the active journal path. */
	archivePoisoned(timestamp = Date.now()): string {
		this.close();
		const archived = `${this.path}.poisoned-${timestamp}`;
		renameSync(this.path, archived);
		return archived;
	}
}

function acquireLock(path: string, warn?: (message: string) => void): string {
	const lockPath = `${path}.lock`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			return lockPath;
		} catch (error) {
			if (!existsSync(lockPath)) throw error;
			const raw = readFileSync(lockPath, "utf8").trim();
			const pid = Number(raw);
			if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
				throw new ReplicateError(`another apply is running (journal lock pid ${pid})`);
			}
			warn?.(`Replacing stale replication journal lock ${lockPath} (pid ${raw || "unknown"})`);
			unlinkSync(lockPath);
		}
	}
	throw new ReplicateError(`Could not acquire journal lock ${lockPath}`);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function warningCallback(options: JournalOptionInput): ((message: string) => void) | undefined {
	return typeof options === "function" ? options : options.warn;
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch (error) {
		if (existsSync(lockPath)) throw error;
	}
}

function parseJournal(path: string): JournalEntry[] {
	const text = readFileSync(path, "utf8");
	const lastNewline = text.lastIndexOf("\n");
	// The trailing newline is each record's commit marker. Bytes past the final
	// newline are a torn write (crash mid-append) REGARDLESS of whether they
	// happen to parse — `{...}\n` truncated by one byte is still valid JSON, but
	// its fsync never completed. Drop them from disk so appends continue a clean
	// committed stream.
	if (lastNewline !== text.length - 1) {
		truncateSync(path, lastNewline < 0 ? 0 : Buffer.byteLength(text.slice(0, lastNewline + 1)));
	}
	const committed = lastNewline < 0 ? "" : text.slice(0, lastNewline);
	if (committed === "") {
		return [];
	}
	const entries: JournalEntry[] = [];
	const lines = committed.split("\n");
	for (let index = 0; index < lines.length; index++) {
		try {
			entries.push(JSON.parse(lines[index] ?? "") as JournalEntry);
		} catch {
			// A committed (newline-terminated) record that does not parse is real
			// corruption — never silently skip journal facts.
			throw new ReplicateError(`Journal ${path} is corrupt at line ${index + 1}`);
		}
	}
	return entries;
}

function validateBinding(header: JournalHeader, expected: JournalExpectedBinding): void {
	if (header.snapshotDigest !== expected.snapshotDigest) {
		throw new ReplicateError(
			`Journal snapshot digest mismatch: expected ${expected.snapshotDigest}, found ${header.snapshotDigest}`,
		);
	}
	if (header.target.baseUrl !== expected.targetBaseUrl) {
		throw new ReplicateError(
			`Journal target base URL mismatch: expected ${expected.targetBaseUrl}, found ${header.target.baseUrl}`,
		);
	}
	if (header.target.workspaceSlug !== expected.targetWorkspaceSlug) {
		throw new ReplicateError(
			`Journal target workspace mismatch: expected ${expected.targetWorkspaceSlug}, found ${header.target.workspaceSlug}`,
		);
	}
}
