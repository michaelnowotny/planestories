import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalEntry } from "../../../src/replicate/journal.ts";
import { relinkMarkdownCorpus } from "../../../src/replicate/relink.ts";
import { sampleSnapshot } from "./fixtures.ts";

const target = {
	baseUrl: "https://target.example.test",
	workspaceSlug: "target",
	workItemWebUrl: (projectId: string, itemId: string) =>
		`https://target.example.test/target/projects/${projectId}/issues/${itemId}`,
};

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "planestories-relink-"));
	const snapshot = sampleSnapshot();
	const journalPath = join(dir, "apply.jsonl");
	const entries: JournalEntry[] = [
		{
			type: "header",
			runId: "run",
			createdAt: "2025-01-01T00:00:00Z",
			toolVersion: "test",
			snapshotDigest: snapshot.digest,
			target: { baseUrl: target.baseUrl, workspaceSlug: target.workspaceSlug },
			destName: "Target",
			destIdentifier: "DST",
			identifierMode: "exact",
		},
		{ type: "project-created", projectId: "project-target", identifier: "DST", name: "Target" },
		{ type: "item-created", seq: 1, sourceItemId: "source-1", targetItemId: "target-1" },
		{ type: "apply-complete" },
	];
	writeFileSync(journalPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { dir, snapshot, journalPath };
}

const linked = `## Story
\`\`\`yaml
plane_id: source-1
plane_identifier: SRC-1
plane_url: https://source.example.test/old
other: source-1
\`\`\`
Body plane_id: source-1

\`\`\`yaml
plane_id: source-1
\`\`\`
`;

describe("replicate relink", () => {
	test("dry-run plans mapped rewrites and leaves bytes untouched", () => {
		const ctx = fixture();
		const path = join(ctx.dir, "stories.md");
		writeFileSync(path, linked);
		try {
			const result = relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [path],
				journalPath: ctx.journalPath,
				yes: false,
			});
			expect(result.rewrites).toBe(3);
			expect(readFileSync(path, "utf8")).toBe(linked);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("rewrites id, changed prefix, and URL while leaving bodies and unrelated yaml byte-identical", () => {
		const ctx = fixture();
		const path = join(ctx.dir, "stories.md");
		writeFileSync(path, linked);
		try {
			relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [path],
				journalPath: ctx.journalPath,
				yes: true,
			});
			const actual = readFileSync(path, "utf8");
			expect(actual).toContain("plane_id: target-1");
			expect(actual).toContain("plane_identifier: DST-1");
			expect(actual).toContain(
				"plane_url: https://target.example.test/target/projects/project-target/issues/target-1",
			);
			expect(actual).toContain("other: source-1");
			expect(actual).toContain("Body plane_id: source-1");
			expect(actual.match(/plane_id: source-1/g)).toHaveLength(2);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("warns and leaves unmatched ids untouched", () => {
		const ctx = fixture();
		const path = join(ctx.dir, "foreign.md");
		const content = linked.replaceAll("source-1", "foreign-id");
		writeFileSync(path, content);
		try {
			const result = relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [path],
				journalPath: ctx.journalPath,
				yes: true,
			});
			expect(result.unmatched).toBe(1);
			expect(readFileSync(path, "utf8")).toBe(content);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("parse failure aborts before any write and directory traversal is recursive", () => {
		const ctx = fixture();
		const nested = join(ctx.dir, "corpus", "nested");
		mkdirSync(nested, { recursive: true });
		const valid = join(nested, "valid.md");
		const invalid = join(ctx.dir, "corpus", "invalid.md");
		writeFileSync(valid, linked);
		writeFileSync(invalid, "no stories here\n");
		try {
			expect(() =>
				relinkMarkdownCorpus(target, ctx.snapshot, {
					paths: [join(ctx.dir, "corpus")],
					journalPath: ctx.journalPath,
					yes: true,
				}),
			).toThrow(/No H2 headings/);
			expect(readFileSync(valid, "utf8")).toBe(linked);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("recursively rewrites markdown below a directory", () => {
		const ctx = fixture();
		const nested = join(ctx.dir, "corpus", "a", "b");
		mkdirSync(nested, { recursive: true });
		const path = join(nested, "story.md");
		writeFileSync(path, linked);
		try {
			const result = relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [join(ctx.dir, "corpus")],
				journalPath: ctx.journalPath,
				yes: true,
			});
			expect(result.filesChanged).toBe(1);
			expect(readFileSync(path, "utf8")).toContain("plane_id: target-1");
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});
});

describe("codex P3 relink fixes", () => {
	test("an indented nested line with the same value is never the rewrite target (C2)", () => {
		const ctx = fixture();
		const path = join(ctx.dir, "nested.md");
		writeFileSync(
			path,
			"## Story\n```yaml\nmeta:\n  plane_id: source-1\nplane_id: source-1\n```\n",
		);
		try {
			relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [path],
				journalPath: ctx.journalPath,
				yes: true,
			});
			const actual = readFileSync(path, "utf8");
			expect(actual).toContain("  plane_id: source-1");
			expect(actual).toContain("\nplane_id: target-1");
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("--dest-identifier override wins over the journal header prefix (C4)", () => {
		const ctx = fixture();
		const path = join(ctx.dir, "stories.md");
		writeFileSync(path, "## Story\n```yaml\nplane_id: source-1\nplane_identifier: SRC-1\n```\n");
		try {
			relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [path],
				journalPath: ctx.journalPath,
				yes: true,
				destIdentifierOverride: "RENAMED",
			});
			expect(readFileSync(path, "utf8")).toContain("plane_identifier: RENAMED-1");
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	test("explicit symlink arguments are refused; traversal skips symlinks (C6)", () => {
		const ctx = fixture();
		const realFile = join(ctx.dir, "real.md");
		writeFileSync(realFile, "## Story\n```yaml\nplane_id: source-1\n```\n");
		const link = join(ctx.dir, "link.md");
		symlinkSync(realFile, link);
		try {
			expect(() =>
				relinkMarkdownCorpus(target, ctx.snapshot, {
					paths: [link],
					journalPath: ctx.journalPath,
					yes: false,
				}),
			).toThrow(/symlink/);
			const result = relinkMarkdownCorpus(target, ctx.snapshot, {
				paths: [ctx.dir],
				journalPath: ctx.journalPath,
				yes: false,
			});
			expect(result.files.map((file) => file.path)).toContain(realFile);
			expect(result.files.map((file) => file.path)).not.toContain(link);
		} finally {
			rmSync(ctx.dir, { recursive: true, force: true });
		}
	});
});
