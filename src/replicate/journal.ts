import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
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
	| { type: "project-intent"; identifier: string; name: string }
	| { type: "project-created"; projectId: string; identifier: string; name: string }
	| {
			type: "state-mapped";
			sourceStateId: string;
			targetStateId: string;
			action: "matched" | "created" | "patched";
	  }
	| {
			type: "label-mapped";
			sourceLabelId: string;
			targetLabelId: string;
			action: "created" | "adopted";
	  }
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
			const entries = parseJournal(path, true);
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

	/**
	 * Open `path`, or DISCARD it and return null when it holds zero committed
	 * records — a crash during the very first header write leaves a file whose
	 * only content is torn residue. Such a file states no facts, so treating it
	 * as corruption would brick the run behind an error no flag resolves.
	 */
	static openOrDiscardTorn(
		path: string,
		expected: JournalExpectedBinding,
		options: JournalOptionInput = {},
	): Journal | null {
		const lockPath = acquireLock(path, warningCallback(options));
		let keepLock = false;
		try {
			if (!existsSync(path)) {
				return null;
			}
			const entries = parseJournal(path, true);
			if (entries.length === 0) {
				unlinkSync(path);
				warningCallback(options)?.(
					`Discarded journal ${path}: it held no committed records (torn first write).`,
				);
				return null;
			}
			const header = entries[0];
			if (!header || header.type !== "header") {
				throw new ReplicateError(`Journal ${path} has no valid header`);
			}
			validateBinding(header, expected);
			const fd = openSync(path, "a");
			keepLock = true;
			return new Journal(path, fd, entries, lockPath);
		} finally {
			if (!keepLock) releaseLock(lockPath);
		}
	}

	/**
	 * Ownership backstop: the rename-steal narrows but cannot fully close the
	 * delayed-stealer race without kernel flock (unavailable without native
	 * deps). Callers re-check before every DURABLE operation — every journal
	 * append AND every Plane write (via the apply layer's guarded client) — so a
	 * process on the losing side of a steal stops at its next operation instead
	 * of continuing to mutate state another process now owns.
	 */
	assertOwnership(): void {
		let holder: string;
		try {
			holder = readFileSync(this.lockPath, "utf8").trim();
		} catch {
			holder = "";
		}
		if (holder !== String(process.pid)) {
			throw new ReplicateError(
				`Journal lock for ${this.path} is no longer held by this process (holder: ${holder || "none"}) — refusing to write.`,
			);
		}
	}

	append(entry: JournalEntry): void {
		if (this.closed) {
			throw new ReplicateError(`Cannot append to closed journal ${this.path}`);
		}
		this.assertOwnership();
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

	/**
	 * Every sequence id this journal created on the destination — real items AND
	 * gap placeholders. The divergence guard needs it so a destination holding the
	 * residue of our own interrupted run is not mistaken for a diverged board.
	 */
	createdSequenceIds(): number[] {
		return this.entries
			.filter(
				(entry): entry is Extract<JournalEntry, { type: "item-created" }> =>
					entry.type === "item-created",
			)
			.map((entry) => entry.seq);
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

	/** A project-create intent with no matching create — the ambiguous window. */
	get projectIntent(): Extract<JournalEntry, { type: "project-intent" }> | null {
		if (this.projectCreated) return null;
		return (
			this.entries.find(
				(entry): entry is Extract<JournalEntry, { type: "project-intent" }> =>
					entry.type === "project-intent",
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
		// Renaming a journal another contender now owns would yank its ledger
		// out from under it — ownership is required like any other mutation.
		this.assertOwnership();
		this.close();
		const archived = `${this.path}.poisoned-${timestamp}`;
		renameSync(this.path, archived);
		return archived;
	}
}

function acquireLock(path: string, warn?: (message: string) => void): string {
	const lockPath = `${path}.lock`;
	for (let attempt = 0; attempt < 3; attempt++) {
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
			// Steal via ATOMIC RENAME, never a blind unlink: two contenders can
			// both read the same stale pid, and with unlink the loser would then
			// remove the WINNER's freshly written lock — both proceed. rename
			// succeeds for exactly one contender; the loser loops and re-examines
			// whatever lock now exists.
			const staleName = `${lockPath}.stale-${process.pid}-${attempt}`;
			try {
				renameSync(lockPath, staleName);
			} catch {
				continue;
			}
			// rename operates by PATH, so a delayed stealer can grab a lock that
			// was REPLACED since it read the stale pid. Verify we renamed the lock
			// we examined; if not, restore it and retry. The restore uses LINK,
			// never rename: link fails with EEXIST when a third contender has
			// already wx-created a fresh lock, so we can never clobber a live
			// lock. If the restore loses that race, the victim's ownership is
			// genuinely gone and its own per-operation ownership checks stop it.
			let stolen: string;
			try {
				stolen = readFileSync(staleName, "utf8").trim();
			} catch {
				stolen = "";
			}
			if (stolen !== raw) {
				restoreDisplacedLock(staleName, lockPath);
				continue;
			}
			warn?.(`Replacing stale replication journal lock ${lockPath} (pid ${raw || "unknown"})`);
			try {
				unlinkSync(staleName);
			} catch {
				// The stale artifact is inert; leaving it is harmless.
			}
		}
	}
	throw new ReplicateError(`Could not acquire journal lock ${lockPath}`);
}

/**
 * Put a displaced (wrongly renamed-away) lock back WITHOUT ever clobbering a
 * lock some third contender created meanwhile: link() fails with EEXIST when
 * the path is taken, unlike rename() which silently overwrites. When the
 * restore loses that race the displaced owner's lock is genuinely gone — its
 * own per-operation ownership checks stop it — and the debris file is inert.
 * Exported for the deterministic three-contender test.
 */
export function restoreDisplacedLock(staleName: string, lockPath: string): void {
	try {
		linkSync(staleName, lockPath);
		unlinkSync(staleName);
	} catch {
		// A third contender holds the path; leave the debris (inert).
	}
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
	// Ownership-checked release: never unlink a lock another process now holds
	// (e.g. after our stale lock was legitimately stolen while we were dying).
	try {
		if (readFileSync(lockPath, "utf8").trim() !== String(process.pid)) {
			return;
		}
		unlinkSync(lockPath);
	} catch (error) {
		if (existsSync(lockPath)) throw error;
	}
}

/**
 * Read committed journal facts without acquiring a lock or modifying the file.
 * A final non-newline-terminated fragment is an uncommitted torn write and is
 * ignored in memory; committed corruption still fails closed.
 */
export function readJournal(path: string): JournalEntry[] {
	if (!existsSync(path)) {
		throw new ReplicateError(`Journal does not exist: ${path}`);
	}
	return parseJournal(path, false);
}

function parseJournal(path: string, repair: boolean): JournalEntry[] {
	const text = readFileSync(path, "utf8");
	const lastNewline = text.lastIndexOf("\n");
	// The trailing newline is each record's commit marker. Bytes past the final
	// newline are a torn write (crash mid-append) REGARDLESS of whether they
	// happen to parse — `{...}\n` truncated by one byte is still valid JSON, but
	// its fsync never completed. Drop them from disk so appends continue a clean
	// committed stream.
	if (repair && lastNewline !== text.length - 1) {
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
