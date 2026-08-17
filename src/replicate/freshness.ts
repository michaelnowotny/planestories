import { ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect, PlaneIssueRelations } from "../plane/client.ts";
import { sweepFetch } from "../utils/sweep.ts";
import { compareInstants, sameNullableInstant } from "./instants.ts";
import { compactRelations } from "./snapshot.ts";
import type { ProjectSnapshot, SnapshotRelations } from "./types.ts";

export interface FreshnessClient {
	readonly dialect: PlaneEndpointDialect;
	concurrency?(): number | undefined;
	listWorkItems<T>(projectId: string): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
	workItemCensus?(
		projectId: string,
	): Promise<{ totalCount: number; maxSequenceId: number | null } | null>;
}

interface RawComment {
	id: string;
	comment_html?: string;
	created_at?: string | null;
}

interface RawItem {
	id: string;
	sequence_id: number;
	updated_at?: string | null;
}

export interface FreshnessReport {
	fresh: boolean;
	takenAt: string;
	counts: { snapshot: number; source: number; comparableSnapshot: number };
	sequence: { snapshot: number[]; source: number[] };
	maxUpdatedAt: { snapshot: string | null; source: string | null };
	drifted: Array<{
		id: string;
		sequenceId: number;
		snapshot: string | null;
		source: string | null;
	}>;
	added: Array<{ id: string; sequenceId: number }>;
	deleted: Array<{ id: string; sequenceId: number }>;
	/** Items whose COMMENTS changed (deep mode only; same-instance id-exact). */
	commentDrift: Array<{ id: string; sequenceId: number; detail: string }>;
	/** Items whose RELATIONS changed (deep mode only). */
	relationDrift: Array<{ id: string; sequenceId: number; detail: string }>;
	deep: boolean;
	notes: string[];
}

/**
 * The CHEAP freshness signal: one request, comparing the source's item count and
 * highest sequence id against the snapshot.
 *
 * Deliberately weaker than `checkFreshness`, and it says so. It cannot see an edit
 * to an existing item — only additions, deletions that change the count, and new
 * sequence numbers. It exists because the full check costs a complete enumeration,
 * which a rate-limited instance cannot always pay: during a real cutover the
 * operator could not get ANY freshness verdict because the source 429'd, and had to
 * reason from circumstance instead. A weak answer you can afford beats a strong one
 * you cannot.
 */
export async function checkFreshnessQuick(
	client: FreshnessClient,
	snapshot: ProjectSnapshot,
): Promise<QuickFreshnessReport> {
	if (!client.workItemCensus) {
		throw new ReplicateError("This client cannot take a census; use the full freshness check.");
	}
	const census = await client.workItemCensus(snapshot.source.projectId);
	if (census === null) {
		throw new ReplicateError(
			"The instance did not return a usable item count, so the quick check cannot conclude anything. Run the full check (omit --quick).",
		);
	}
	// The census reads the ordinary list endpoint, whose total_count is the LIVE set.
	// Comparing it against snapshot.items (live + archived) reports CHANGED on any
	// board with archived items — a false alarm on the real board this was built for.
	const liveItems = snapshot.items.filter((item) => !item.archived);
	const snapshotCount = liveItems.length;
	const snapshotMax = liveItems.reduce((max, item) => Math.max(max, item.sequenceId), 0);
	const countMatches = census.totalCount === snapshotCount;
	const maxMatches = census.maxSequenceId === null || census.maxSequenceId === snapshotMax;
	return {
		quick: true,
		fresh: countMatches && maxMatches,
		takenAt: snapshot.takenAt,
		counts: { snapshot: snapshotCount, source: census.totalCount },
		maxSequenceId: { snapshot: snapshotMax, source: census.maxSequenceId },
		notes: [
			"QUICK CHECK — one request, comparing item count and highest sequence id only.",
			"It CANNOT see edits to existing items, nor a deletion masked by an addition. A FRESH verdict here is weaker evidence than the full check; use it to catch obvious drift cheaply, not to certify a cutover.",
			"ARCHIVED items are out of scope: the census counts the live set only, so both sides are compared live-only.",
			...(census.maxSequenceId === null
				? ["The instance did not return a top sequence id; only the count was compared."]
				: []),
		],
	};
}

export interface QuickFreshnessReport {
	quick: true;
	fresh: boolean;
	takenAt: string;
	counts: { snapshot: number; source: number };
	maxSequenceId: { snapshot: number; source: number | null };
	notes: string[];
}

export function formatQuickFreshnessReport(report: QuickFreshnessReport, json = false): string {
	if (json) return JSON.stringify(report, null, 1);
	const lines = [
		report.fresh
			? "QUICK: no change detected (weak signal — see the note below)"
			: "QUICK: CHANGED since the snapshot",
		`  items         snapshot ${report.counts.snapshot} · source ${report.counts.source}`,
		`  max sequence  snapshot ${report.maxSequenceId.snapshot} · source ${report.maxSequenceId.source ?? "unknown"}`,
	];
	for (const note of report.notes) lines.push(`  note: ${note}`);
	return lines.join("\n");
}

export async function checkFreshness(
	client: FreshnessClient,
	snapshot: ProjectSnapshot,
	options: { deep?: boolean; concurrency?: number } = {},
): Promise<FreshnessReport> {
	if (client.dialect !== snapshot.source.dialect) {
		throw new ReplicateError(
			`Freshness must use the snapshot dialect ${snapshot.source.dialect}, found ${client.dialect}`,
		);
	}
	const live = await client.listWorkItems<RawItem>(snapshot.source.projectId);
	const archived = await client.listArchivedWorkItems<RawItem>(snapshot.source.projectId);
	const notes: string[] = [];
	const expected =
		archived === null ? snapshot.items.filter((item) => !item.archived) : snapshot.items;
	const actual = archived === null ? live : [...live, ...archived];
	if (archived === null) {
		notes.push(
			"Archived endpoint unavailable; freshness compares the live inventory only and cannot arbitrate archived-item drift.",
		);
	}
	const expectedById = new Map(expected.map((item) => [item.id, item]));
	const actualById = new Map(actual.map((item) => [item.id, item]));
	if (actualById.size !== actual.length) {
		throw new ReplicateError("Freshness source response contains duplicate work-item ids");
	}
	const added = actual
		.filter((item) => !expectedById.has(item.id))
		.map((item) => ({ id: item.id, sequenceId: item.sequence_id }));
	const deleted = expected
		.filter((item) => !actualById.has(item.id))
		.map((item) => ({ id: item.id, sequenceId: item.sequenceId }));
	const drifted = expected.flatMap((item) => {
		const current = actualById.get(item.id);
		if (!current || sameNullableInstant(item.updatedAt, current.updated_at ?? null)) return [];
		return [
			{
				id: item.id,
				sequenceId: item.sequenceId,
				snapshot: item.updatedAt,
				source: current.updated_at ?? null,
			},
		];
	});
	const snapshotSequence = expected.map((item) => item.sequenceId).sort((a, b) => a - b);
	const sourceSequence = actual.map((item) => item.sequence_id).sort((a, b) => a - b);
	const snapshotMax = maxInstant(expected.map((item) => item.updatedAt));
	const sourceMax = maxInstant(actual.map((item) => item.updated_at ?? null));

	// Plane creates comments and relations WITHOUT saving the parent issue, so
	// comment/relation-only edits never bump item updated_at (verified against
	// Plane's API source in review). The item-level check is therefore blind to
	// them — state that always, and offer --deep to actually compare them.
	const commentDrift: FreshnessReport["commentDrift"] = [];
	const relationDrift: FreshnessReport["relationDrift"] = [];
	if (options.deep) {
		const present = expected.filter((item) => actualById.has(item.id));
		const concurrency = options.concurrency ?? client.concurrency?.() ?? 4;
		const commentSweep = await sweepFetch(
			present,
			(item) => client.listWorkItemComments<RawComment>(snapshot.source.projectId, item.id),
			concurrency,
		);
		if (commentSweep.failures.length > 0) {
			throw new ReplicateError(
				`Freshness --deep incomplete: comment fetch failed for ${commentSweep.failures.length} item(s)`,
			);
		}
		for (const { item, value } of commentSweep.results) {
			const expectedComments = snapshot.comments[item.id] ?? [];
			const expectedById = new Map(expectedComments.map((comment) => [comment.id, comment]));
			const actualIds = new Set(value.map((comment) => comment.id));
			const addedComments = value.filter((comment) => !expectedById.has(comment.id));
			const deletedComments = expectedComments.filter((comment) => !actualIds.has(comment.id));
			const editedComments = value.filter((comment) => {
				const prior = expectedById.get(comment.id);
				return prior !== undefined && (comment.comment_html ?? "") !== prior.commentHtml;
			});
			if (addedComments.length + deletedComments.length + editedComments.length > 0) {
				commentDrift.push({
					id: item.id,
					sequenceId: item.sequenceId,
					detail: `${addedComments.length} added, ${deletedComments.length} deleted, ${editedComments.length} edited comment(s)`,
				});
			}
		}
		const relationSweep = await sweepFetch(
			present,
			(item) => client.getRelations(snapshot.source.projectId, item.id),
			concurrency,
		);
		if (relationSweep.failures.length > 0) {
			throw new ReplicateError(
				`Freshness --deep incomplete: relation fetch failed for ${relationSweep.failures.length} item(s)`,
			);
		}
		for (const { item, value } of relationSweep.results) {
			const current = compactRelations(value);
			const prior = snapshot.relations[item.id] ?? null;
			if (!sameRelations(current, prior)) {
				relationDrift.push({
					id: item.id,
					sequenceId: item.sequenceId,
					detail: "relation set changed",
				});
			}
		}
	} else {
		notes.push(
			"Item-level check only: comment/relation-only edits do not bump item updated_at " +
				"(Plane API behavior) and are invisible here — run with --deep for full coverage.",
		);
	}

	const fresh =
		added.length === 0 &&
		deleted.length === 0 &&
		drifted.length === 0 &&
		commentDrift.length === 0 &&
		relationDrift.length === 0 &&
		sameNumbers(snapshotSequence, sourceSequence) &&
		sameNullableInstant(snapshotMax, sourceMax);
	return {
		fresh,
		takenAt: snapshot.takenAt,
		counts: {
			snapshot: snapshot.items.length,
			source: actual.length,
			comparableSnapshot: expected.length,
		},
		sequence: { snapshot: snapshotSequence, source: sourceSequence },
		maxUpdatedAt: { snapshot: snapshotMax, source: sourceMax },
		drifted,
		added,
		deleted,
		commentDrift,
		relationDrift,
		deep: options.deep === true,
		notes,
	};
}

function sameRelations(a: SnapshotRelations | null, b: SnapshotRelations | null): boolean {
	const canonical = (value: SnapshotRelations | null): string => {
		const entries = Object.entries(value ?? {})
			.filter((entry): entry is [string, string[]] => (entry[1] as string[]).length > 0)
			.map(([kind, ids]) => [kind, [...ids].sort()] as const)
			.sort((x, y) => x[0].localeCompare(y[0]));
		return JSON.stringify(Object.fromEntries(entries));
	};
	return canonical(a) === canonical(b);
}

export function formatFreshnessReport(report: FreshnessReport, json = false): string {
	if (json) return JSON.stringify(report, null, 2);
	if (report.fresh) {
		return [`Fresh as of ${report.takenAt}.`, ...report.notes.map((note) => `Note: ${note}`)].join(
			"\n",
		);
	}
	const lines = [
		`Stale since ${report.takenAt}: ${report.added.length} added, ${report.deleted.length} deleted, ${report.drifted.length} edited` +
			(report.deep
				? `, ${report.commentDrift.length} comment-drifted, ${report.relationDrift.length} relation-drifted.`
				: "."),
	];
	for (const item of report.added) lines.push(`  ADDED: ${item.id} (#${item.sequenceId})`);
	for (const item of report.deleted) lines.push(`  DELETED: ${item.id} (#${item.sequenceId})`);
	for (const item of report.drifted) {
		lines.push(`  EDITED: ${item.id} (#${item.sequenceId}) ${item.snapshot} -> ${item.source}`);
	}
	for (const item of report.commentDrift) {
		lines.push(`  COMMENTS: ${item.id} (#${item.sequenceId}) ${item.detail}`);
	}
	for (const item of report.relationDrift) {
		lines.push(`  RELATIONS: ${item.id} (#${item.sequenceId}) ${item.detail}`);
	}
	lines.push(...report.notes.map((note) => `Note: ${note}`));
	return lines.join("\n");
}

function maxInstant(values: Array<string | null>): string | null {
	// Total order down to sub-millisecond digits: millisecond-truncated ordering
	// made the winner depend on API row order within one millisecond, producing
	// a false-stale with zero drifted items when compared strictly.
	let max: string | null = null;
	for (const value of values) {
		if (value !== null && (max === null || compareInstants(value, max) > 0)) max = value;
	}
	return max;
}

function sameNumbers(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
