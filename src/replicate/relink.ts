import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ReplicateError } from "../errors.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import { type JournalEntry, type JournalHeader, readJournal } from "./journal.ts";
import type { ProjectSnapshot } from "./types.ts";

export interface RelinkTarget {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	workItemWebUrl(projectId: string, workItemId: string): string;
}

export interface RelinkOptions {
	paths: string[];
	journalPath: string;
	yes: boolean;
	/**
	 * Overrides the journal header's destination identifier for the
	 * plane_identifier rewrites — required after `rename-project --identifier`
	 * on the target, whose new prefix the immutable journal cannot know.
	 */
	destIdentifierOverride?: string;
}

export interface RelinkFileResult {
	path: string;
	rewrites: number;
	unmatchedPlaneIds: string[];
	skipped: boolean;
}

export interface RelinkResult {
	dryRun: boolean;
	files: RelinkFileResult[];
	filesChanged: number;
	rewrites: number;
	unmatched: number;
	skipped: number;
}

interface Mapping {
	targetId: string;
	identifier: string;
	url: string;
}

interface PreparedFile {
	path: string;
	original: string;
	transformed: string;
	result: RelinkFileResult;
}

export function relinkMarkdownCorpus(
	target: RelinkTarget,
	snapshot: ProjectSnapshot,
	options: RelinkOptions,
): RelinkResult {
	const files = collectMarkdownFiles(options.paths);
	const entries = readJournal(options.journalPath);
	const { header, mapping } = buildMapping(
		entries,
		target,
		snapshot,
		options.destIdentifierOverride,
	);
	const prepared: PreparedFile[] = files.map((path) => prepareFile(path, mapping, header));
	if (options.yes) {
		for (const file of prepared) {
			if (file.original === file.transformed) continue;
			atomicReplace(file.path, file.transformed);
		}
	}
	return {
		dryRun: !options.yes,
		files: prepared.map((file) => file.result),
		filesChanged: prepared.filter((file) => file.original !== file.transformed).length,
		rewrites: prepared.reduce((sum, file) => sum + file.result.rewrites, 0),
		unmatched: prepared.reduce((sum, file) => sum + file.result.unmatchedPlaneIds.length, 0),
		skipped: prepared.filter((file) => file.result.skipped).length,
	};
}

function buildMapping(
	entries: JournalEntry[],
	target: RelinkTarget,
	snapshot: ProjectSnapshot,
	destIdentifierOverride?: string,
): { header: JournalHeader; projectId: string; mapping: Map<string, Mapping> } {
	const header = entries[0];
	if (!header || header.type !== "header") throw new ReplicateError("Relink journal has no header");
	if (header.snapshotDigest !== snapshot.digest) {
		throw new ReplicateError("Relink journal snapshot digest does not match the snapshot");
	}
	if (
		header.target.baseUrl !== target.baseUrl ||
		header.target.workspaceSlug !== target.workspaceSlug
	) {
		throw new ReplicateError("Relink journal target does not match the selected --to context");
	}
	if (!entries.some((entry) => entry.type === "apply-complete")) {
		throw new ReplicateError("Relink journal is incomplete: apply-complete is missing");
	}
	const projects = entries.filter((entry) => entry.type === "project-created");
	if (projects.length !== 1)
		throw new ReplicateError("Relink journal needs one project-created entry");
	const projectId = projects[0]!.projectId;
	const mapping = new Map<string, Mapping>();
	for (const entry of entries) {
		if (entry.type !== "item-created" || entry.sourceItemId === null) continue;
		if (mapping.has(entry.sourceItemId)) {
			throw new ReplicateError(
				`Relink journal maps source item ${entry.sourceItemId} more than once`,
			);
		}
		mapping.set(entry.sourceItemId, {
			targetId: entry.targetItemId,
			identifier: `${destIdentifierOverride ?? header.destIdentifier}-${entry.seq}`,
			url: target.workItemWebUrl(projectId, entry.targetItemId),
		});
	}
	return { header, projectId, mapping };
}

function prepareFile(
	path: string,
	mapping: Map<string, Mapping>,
	_header: JournalHeader,
): PreparedFile {
	const original = readFileSync(path, "utf8");
	// A directory of markdown is mostly NOT story files. Skip anything with no
	// plane_id before parsing: a real cutover died here because an unrelated
	// planning doc contained a docker-compose example whose fenced YAML has two
	// `environment:` keys, and the parser refused it. A file we would never
	// rewrite must not be able to fail the run.
	if (!/^\s*plane_id\s*:/m.test(original)) {
		return {
			path,
			original,
			transformed: original,
			result: { path, rewrites: 0, unmatchedPlaneIds: [], skipped: true },
		};
	}
	// A plane_id-bearing file that will not parse STILL aborts the run: it is a file we
	// would have had to rewrite, and silently skipping it would leave dead source UUIDs
	// behind — precisely the breakage relink exists to prevent.
	const parsed = parseMarkdownFile(original, path);
	const unmatchedPlaneIds = [
		...new Set(
			parsed.stories
				.map((story) => story.planeId)
				.filter((id): id is string => id !== null && !mapping.has(id)),
		),
	];
	let storyIndex = 0;
	let rewrites = 0;
	const transformed = original.replace(
		/(^## [^\n]*(?:\n|$)[\s\S]*?)(?=^## |(?![\s\S]))/gm,
		(section) => {
			const story = parsed.stories[storyIndex++];
			if (!story?.planeId) return section;
			const target = mapping.get(story.planeId);
			if (!target) return section;
			const block = /```yaml\r?\n[\s\S]*?```/.exec(section);
			if (!block) return section;
			let yaml = block[0];
			for (const [field, oldValue, newValue] of [
				["plane_id", story.planeId, target.targetId],
				["plane_identifier", story.planeIdentifier, target.identifier],
				["plane_url", story.planeUrl, target.url],
			] as const) {
				if (oldValue === null) continue;
				// TOP-LEVEL keys only (column 0): an indented nested mapping line
				// carrying the same value must never be the rewrite target.
				yaml = yaml.replace(new RegExp(`^(${field}:\\s*)(.*)$`, "m"), (line, prefix, raw) => {
					if (!scalarEquals(String(raw), oldValue)) return line;
					rewrites++;
					return `${prefix}${newValue}`;
				});
			}
			return `${section.slice(0, block.index)}${yaml}${section.slice(block.index + block[0].length)}`;
		},
	);
	return {
		path,
		original,
		transformed,
		result: {
			path,
			rewrites,
			unmatchedPlaneIds,
			skipped: parsed.stories.every((story) => story.planeId === null),
		},
	};
}

function scalarEquals(raw: string, expected: string): boolean {
	const trimmed = raw.trim();
	return (
		trimmed === expected ||
		(trimmed.length >= 2 &&
			((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
				(trimmed.startsWith("'") && trimmed.endsWith("'"))) &&
			trimmed.slice(1, -1) === expected)
	);
}

function collectMarkdownFiles(paths: string[]): string[] {
	const out = new Set<string>();
	const visitedDirs = new Set<string>();
	const visit = (path: string, explicit: boolean): void => {
		let lstat: ReturnType<typeof lstatSync>;
		try {
			lstat = lstatSync(path);
		} catch {
			throw new ReplicateError(`Relink path does not exist: ${path}`);
		}
		if (lstat.isSymbolicLink()) {
			// A rename-over-symlink would replace the LINK with a regular file and
			// leave the referent untouched — silent corruption of intent. Explicit
			// symlink arguments fail loudly; ones found during traversal are skipped.
			if (explicit) {
				throw new ReplicateError(
					`Relink refuses symlink ${path}: pass the resolved target path instead.`,
				);
			}
			return;
		}
		if (lstat.isFile()) {
			if (extname(path).toLowerCase() === ".md") out.add(path);
			return;
		}
		if (!lstat.isDirectory())
			throw new ReplicateError(`Relink path is not a file or directory: ${path}`);
		const real = realpathSync(path);
		if (visitedDirs.has(real)) return;
		visitedDirs.add(real);
		for (const entry of readdirSync(path).sort()) visit(join(path, entry), false);
	};
	for (const path of paths) visit(path, true);
	return [...out].sort();
}

function atomicReplace(path: string, content: string): void {
	const directory = dirname(path);
	const tempDirectory = mkdtempSync(join(directory, `.${basename(path)}.psrelink-`));
	const tempPath = join(tempDirectory, basename(path));
	try {
		writeFileSync(tempPath, content, { mode: lstatSync(path).mode });
		chmodSync(tempPath, lstatSync(path).mode);
		renameSync(tempPath, path);
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
}

export function formatRelinkResult(result: RelinkResult): string {
	const lines = [
		`${result.dryRun ? "Dry run" : "Relink complete"}: ${result.filesChanged} file(s), ${result.rewrites} field rewrite(s), ${result.unmatched} unmatched plane_id(s), ${result.skipped} skipped file(s).`,
	];
	for (const file of result.files.filter((value) => !value.skipped)) {
		lines.push(`  ${file.path}: ${file.rewrites} rewrite(s)`);
		for (const id of file.unmatchedPlaneIds) lines.push(`    WARNING: unmatched plane_id ${id}`);
	}
	if (result.dryRun) lines.push("Nothing was written. Re-run with --yes to apply.");
	return lines.join("\n");
}
