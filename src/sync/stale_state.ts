import type { AtlasGraph } from "../atlas/model.ts";
import { ConfigError } from "../errors.ts";
import { htmlToMarkdown } from "../markdown/html.ts";

/** Open enough that a "done" comment can disagree with the board state. */
const OPEN_GROUPS = new Set(["backlog", "unstarted", "started", "unknown"]);

export interface StaleStateComment {
	id: string;
	commentHtml: string;
	createdAt: string | null;
}

export interface StaleStateCandidate {
	identifier: string;
	title: string;
	status: string | null;
	commentAt: string | null;
	/** The closed-language word that matched, lowercased. */
	matched: string;
	excerpt: string;
}

export interface StaleStateReport {
	/** Always true. This list is a heuristic, not a measured state change. */
	heuristic: true;
	fetchedAt: string;
	/** Set only when the operator passed --since. Omitted means no time bound. */
	since?: string;
	candidates: StaleStateCandidate[];
}

export function findStaleStateCandidates(
	graph: AtlasGraph,
	commentsById: Readonly<Record<string, readonly StaleStateComment[]>>,
	bounds?: { sinceMs: number; throughMs: number },
): StaleStateCandidate[] {
	const candidates: StaleStateCandidate[] = [];
	for (const node of flatten(graph.nodes)) {
		if (!OPEN_GROUPS.has(node.statusGroup)) continue;
		const id = workItemIdFromUrl(node.url);
		if (!id || !node.identifier) {
			throw new ConfigError(
				`Open item "${node.title}" has no work-item id, so its comments cannot be checked. Refusing to report it as clear.`,
			);
		}
		const latest = latestComment(commentsById[id] ?? []);
		if (!latest) continue;
		const commentMs = latest.createdAt === null ? null : Date.parse(latest.createdAt);
		if (bounds) {
			if (commentMs === null || Number.isNaN(commentMs)) continue;
			if (commentMs < bounds.sinceMs || commentMs > bounds.throughMs) continue;
		}
		const text = htmlToMarkdown(latest.commentHtml);
		const matched = closedLanguage(text);
		if (!matched) continue;
		candidates.push({
			identifier: node.identifier,
			title: node.title,
			status: node.status,
			commentAt: latest.createdAt,
			matched,
			excerpt: excerpt(text),
		});
	}
	candidates.sort(
		(a, b) => a.identifier.localeCompare(b.identifier) || a.title.localeCompare(b.title),
	);
	return candidates;
}

export function formatStaleStateReport(report: StaleStateReport): string {
	const lines = [
		"Heuristic: open items whose latest comment says merged, deployed, done, shipped, released, or closed.",
		"This is not a state change and not proof the work is finished.",
		`Cache: fetched ${report.fetchedAt}`,
	];
	if (report.since !== undefined) {
		lines.push(`Window: latest comment at or after ${report.since}`);
	}
	lines.push(`Candidates: ${report.candidates.length}`);
	for (const candidate of report.candidates) {
		const when = candidate.commentAt ?? "unknown time";
		lines.push(
			`${candidate.identifier} — ${candidate.title} — ${when} — matched ${candidate.matched} — ${candidate.excerpt}`,
		);
	}
	return lines.join("\n");
}

function workItemIdFromUrl(url: string | null): string | null {
	if (!url) return null;
	const path = (() => {
		try {
			return new URL(url).pathname;
		} catch {
			return url.split("?")[0]?.split("#")[0] ?? "";
		}
	})();
	const segment = path.split("/").filter(Boolean).at(-1);
	return segment && segment.length > 0 ? segment : null;
}

function flatten(nodes: AtlasGraph["nodes"]): AtlasGraph["nodes"] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function latestComment(comments: readonly StaleStateComment[]): StaleStateComment | null {
	if (comments.length === 0) return null;
	return (
		[...comments].sort((a, b) => {
			const aMs = a.createdAt === null ? null : Date.parse(a.createdAt);
			const bMs = b.createdAt === null ? null : Date.parse(b.createdAt);
			const aKnown = aMs !== null && !Number.isNaN(aMs);
			const bKnown = bMs !== null && !Number.isNaN(bMs);
			if (aKnown && bKnown && aMs !== bMs) return (bMs as number) - (aMs as number);
			if (aKnown !== bKnown) return aKnown ? -1 : 1;
			return b.id.localeCompare(a.id);
		})[0] ?? null
	);
}

/** The first closed-language word that is not negated. */
export function closedLanguage(text: string): string | null {
	// A fresh regex each call: a shared /g pattern keeps lastIndex and skips words.
	const closedLanguagePattern = /\b(merged|deployed|done|shipped|released|closed)\b/gi;
	for (const match of text.matchAll(closedLanguagePattern)) {
		const index = match.index ?? 0;
		const before = text.slice(Math.max(0, index - 6), index).toLowerCase();
		if (/(?:not |n't )$/.test(before)) continue;
		const word = match[1];
		if (!word) continue;
		return word.toLowerCase();
	}
	return null;
}

function excerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "(empty)";
	return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
