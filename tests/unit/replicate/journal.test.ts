import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Journal,
	type JournalHeader,
	restoreDisplacedLock,
} from "../../../src/replicate/journal.ts";

function tempJournal(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "planestories-journal-"));
	return { dir, path: join(dir, "apply.jsonl") };
}

function header(): JournalHeader {
	return {
		type: "header",
		runId: "run",
		createdAt: "2025-01-01T00:00:00Z",
		toolVersion: "test",
		snapshotDigest: "digest",
		target: { baseUrl: "https://target", workspaceSlug: "workspace" },
		destName: "Destination",
		destIdentifier: "DST",
		identifierMode: "exact",
	};
}

const binding = {
	snapshotDigest: "digest",
	targetBaseUrl: "https://target",
	targetWorkspaceSlug: "workspace",
};

describe("replication journal", () => {
	test("creates, opens, and validates its digest binding", () => {
		const temp = tempJournal();
		try {
			Journal.create(temp.path, header()).close();
			expect(() => Journal.open(temp.path, { ...binding, snapshotDigest: "other" })).toThrow(
				/digest mismatch/,
			);
			const opened = Journal.open(temp.path, binding);
			expect(opened.header.runId).toBe("run");
			opened.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("drops a torn final line but rejects corruption in the middle", () => {
		const torn = tempJournal();
		const corrupt = tempJournal();
		try {
			Journal.create(torn.path, header()).close();
			appendFileSync(torn.path, '{"type":"item-int');
			const recovered = Journal.open(torn.path, binding);
			expect(recovered.entries).toHaveLength(1);
			recovered.close();

			Journal.create(corrupt.path, header()).close();
			appendFileSync(corrupt.path, 'not-json\n{"type":"apply-complete"}\n');
			expect(() => Journal.open(corrupt.path, binding)).toThrow(/corrupt at line 2/);
		} finally {
			rmSync(torn.dir, { recursive: true, force: true });
			rmSync(corrupt.dir, { recursive: true, force: true });
		}
	});

	test("a valid-JSON final record missing its commit newline is torn residue, not corruption", () => {
		// A crash can truncate `{...}\n` to exactly `{...}` — syntactically valid
		// JSON whose commit marker (the newline) never reached disk. Resume must
		// drop it like any torn write; treating it as corruption would make the
		// journal unrecoverable after precisely the crash it exists to survive.
		const temp = tempJournal();
		try {
			Journal.create(temp.path, header()).close();
			appendFileSync(temp.path, '{"type":"cleanup-started"}');
			const recovered = Journal.open(temp.path, binding);
			expect(recovered.entries).toHaveLength(1);
			expect(recovered.cleanupStarted).toBeFalse();
			recovered.append({ type: "apply-complete" });
			recovered.close();
			// The torn bytes were truncated away, so the re-appended stream parses.
			const reopened = Journal.open(temp.path, binding);
			expect(reopened.entries).toHaveLength(2);
			expect(reopened.isComplete).toBeTrue();
			reopened.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("enforces a live lock and steals a stale lock with a warning", () => {
		const temp = tempJournal();
		try {
			const first = Journal.create(temp.path, header());
			expect(() => Journal.open(temp.path, binding)).toThrow(/another apply is running/);
			first.close();
			writeFileSync(`${temp.path}.lock`, "99999999");
			const warnings: string[] = [];
			const stolen = Journal.open(temp.path, binding, {
				warn: (message) => warnings.push(message),
			});
			expect(warnings[0]).toContain("stale");
			stolen.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("release is ownership-checked: closing never unlinks a lock another process holds", () => {
		// After our stale lock is legitimately stolen, our dying close() must not
		// remove the NEW holder's lock — that would let a third contender in.
		const temp = tempJournal();
		try {
			const journal = Journal.create(temp.path, header());
			writeFileSync(`${temp.path}.lock`, "99999999"); // another process took over
			journal.close();
			expect(readFileSync(`${temp.path}.lock`, "utf8")).toBe("99999999");
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("append aborts when the lock has been stolen (ownership re-checked per fact)", () => {
		// The rename-steal narrows but cannot eliminate the two-delayed-stealers
		// race without kernel flock. The backstop: every append re-reads the lock
		// and refuses to write a fact once another pid holds it, so a process on
		// the losing side of a steal stops at its next durable operation.
		const temp = tempJournal();
		try {
			const journal = Journal.create(temp.path, header());
			writeFileSync(`${temp.path}.lock`, "99999999");
			expect(() => journal.append({ type: "cleanup-started" })).toThrow(/lock/);
			journal.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("archivePoisoned refuses to rename a journal whose lock another process holds", () => {
		const temp = tempJournal();
		try {
			const journal = Journal.create(temp.path, header());
			writeFileSync(`${temp.path}.lock`, "99999999");
			expect(() => journal.archivePoisoned(123)).toThrow(/lock/);
			expect(existsSync(temp.path)).toBeTrue();
			expect(existsSync(`${temp.path}.poisoned-123`)).toBeFalse();
			journal.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("a displaced lock is restored via LINK and can never clobber a third contender", () => {
		// Deterministic three-contender scenario, disk-state level: stealer B
		// renamed fresh owner A's lock away (staleName holds A); meanwhile
		// contender C wx-created a new lock at lockPath. B's restore must NOT
		// overwrite C — link() fails on EEXIST where rename() would clobber.
		const temp = tempJournal();
		try {
			const lockPath = `${temp.path}.lock`;
			const staleName = `${lockPath}.stale-77-0`;
			writeFileSync(staleName, "1111"); // displaced owner A
			writeFileSync(lockPath, "2222"); // third contender C already holds the path
			restoreDisplacedLock(staleName, lockPath);
			expect(readFileSync(lockPath, "utf8")).toBe("2222"); // C untouched
			// With the path free, the same restore puts A back.
			rmSync(lockPath);
			restoreDisplacedLock(staleName, lockPath);
			expect(readFileSync(lockPath, "utf8")).toBe("1111");
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	test("derives intents, placeholders, and one-way latches", () => {
		const temp = tempJournal();
		try {
			const journal = Journal.create(temp.path, header());
			journal.append({ type: "item-intent", seq: 1, sourceItemId: "source" });
			journal.append({ type: "item-intent", seq: 2, sourceItemId: null });
			journal.append({
				type: "item-created",
				seq: 2,
				sourceItemId: null,
				targetItemId: "target-2",
			});
			journal.append({ type: "cleanup-started" });
			expect(journal.pendingIntent(1)?.sourceItemId).toBe("source");
			expect(journal.pendingIntent(2)).toBeNull();
			expect(journal.placeholders()).toEqual([{ seq: 2, targetItemId: "target-2" }]);
			expect(journal.cleanupStarted).toBeTrue();
			expect(journal.isComplete).toBeFalse();
			journal.close();
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});
});
