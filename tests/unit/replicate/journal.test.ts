import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type JournalHeader } from "../../../src/replicate/journal.ts";

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
