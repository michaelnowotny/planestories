import { ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect } from "../plane/client.ts";
import type { ProjectSnapshot } from "./types.ts";

export interface FreshnessClient {
	readonly dialect: PlaneEndpointDialect;
	listWorkItems<T>(projectId: string): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
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
	notes: string[];
}

export async function checkFreshness(
	client: FreshnessClient,
	snapshot: ProjectSnapshot,
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
	const fresh =
		added.length === 0 &&
		deleted.length === 0 &&
		drifted.length === 0 &&
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
		notes,
	};
}

export function formatFreshnessReport(report: FreshnessReport, json = false): string {
	if (json) return JSON.stringify(report, null, 2);
	if (report.fresh) {
		return [`Fresh as of ${report.takenAt}.`, ...report.notes.map((note) => `Note: ${note}`)].join(
			"\n",
		);
	}
	const lines = [
		`Stale since ${report.takenAt}: ${report.added.length} added, ${report.deleted.length} deleted, ${report.drifted.length} edited.`,
	];
	for (const item of report.added) lines.push(`  ADDED: ${item.id} (#${item.sequenceId})`);
	for (const item of report.deleted) lines.push(`  DELETED: ${item.id} (#${item.sequenceId})`);
	for (const item of report.drifted) {
		lines.push(`  EDITED: ${item.id} (#${item.sequenceId}) ${item.snapshot} -> ${item.source}`);
	}
	lines.push(...report.notes.map((note) => `Note: ${note}`));
	return lines.join("\n");
}

function maxInstant(values: Array<string | null>): string | null {
	let max: string | null = null;
	for (const value of values) {
		if (value !== null && (max === null || Date.parse(value) > Date.parse(max))) max = value;
	}
	return max;
}

function sameNullableInstant(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return Date.parse(a) === Date.parse(b);
}

function sameNumbers(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
