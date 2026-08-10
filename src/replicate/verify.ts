import { readFileSync } from "node:fs";
import { ReplicateError } from "../errors.ts";
import { htmlToMarkdown } from "../markdown/html.ts";
import { parseMarkdownFile } from "../markdown/parser.ts";
import {
	deriveWebBaseUrl,
	type PlaneEndpointDialect,
	type PlaneIssueRelations,
} from "../plane/client.ts";
import { sweepFetch } from "../utils/sweep.ts";
import { canonicalRelations } from "./apply.ts";
import { type JournalEntry, type JournalHeader, readJournal } from "./journal.ts";
import type { TargetProbeResult } from "./probe.ts";
import type { ProjectSnapshot, SnapshotComment, SnapshotItem } from "./types.ts";

export type VerifySeverity = "failure" | "warning";

export interface VerifyFinding {
	check: string;
	severity: VerifySeverity;
	message: string;
	sourceItemId?: string;
	targetItemId?: string;
	identifier?: string;
}

export interface VerifySkipped {
	check: string;
	field: string;
	message: string;
	sourceItemId?: string;
}

export interface VerifyCounts {
	snapshotItems: number;
	targetItems: number;
	assets: { sourceInstance: number; target: number; other: number };
}

export interface VerifyReport {
	summary: { failures: number; warnings: number; skipped: number; ok: boolean };
	findings: VerifyFinding[];
	skipped: VerifySkipped[];
	counts: VerifyCounts;
}

export interface VerifyClient {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	readonly dialect: PlaneEndpointDialect;
	listWorkItems<T>(projectId: string): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	listStates<T>(projectId: string): Promise<T[]>;
	listLabels<T>(projectId: string): Promise<T[]>;
	listWorkspaceMembers<T>(): Promise<T[]>;
	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
}

export interface VerifyOptions {
	journalPath: string;
	exportFile?: string;
	concurrency?: number;
}

interface RawItem {
	id: string;
	sequence_id: number;
	name?: string;
	description_html?: string | null;
	priority?: string | null;
	point?: number | null;
	state?: unknown;
	parent?: unknown;
	labels?: unknown[];
	assignees?: unknown[];
	created_at?: string | null;
	created_by?: string | null;
	start_date?: string | null;
	target_date?: string | null;
	external_source?: string | null;
	external_id?: string | null;
}

interface RawState {
	id: string;
	name?: string;
	group?: string;
	color?: string;
}

interface RawLabel {
	id: string;
	name?: string;
}

interface RawMember {
	id?: string;
	member?: string;
	email?: string;
}

interface RawComment {
	id: string;
	comment_html?: string;
	created_at?: string | null;
	created_by?: string | null;
	actor?: string | null;
}

interface JournalFacts {
	header: JournalHeader;
	probe: TargetProbeResult;
	projectId: string;
	targetBySource: Map<string, { id: string; seq: number }>;
	sourceByTarget: Map<string, string>;
}

/** Normalize harmless HTML serialization differences before exact comparison. */
export function normalizeHtmlForCompare(html: string): string {
	return html
		.replace(/<([A-Za-z][\w:-]*)([^<>]*?)>/g, (_tag, name: string, raw: string) => {
			if (raw.trim().startsWith("/")) return `<${name}${raw}>`;
			const selfClosing = /\/\s*$/.test(raw);
			const attrs = [...raw.matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
				.filter((match) => !match[1]?.toLowerCase().startsWith("data-psrepl-"))
				.map((match) => (match[2] === undefined ? match[1] : `${match[1]}=${match[2]}`))
				.filter((value): value is string => value !== undefined)
				.sort((a, b) => a.localeCompare(b));
			return `<${name}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}${selfClosing ? " /" : ""}>`;
		})
		.replace(/>\s+</g, "><")
		.trim();
}

export async function verifySnapshot(
	client: VerifyClient,
	snapshot: ProjectSnapshot,
	options: VerifyOptions,
): Promise<VerifyReport> {
	const findings: VerifyFinding[] = [];
	const skipped: VerifySkipped[] = [];
	const add = (finding: VerifyFinding) => findings.push(finding);
	const facts = journalFacts(readJournal(options.journalPath), snapshot, client);

	const [live, archived, states, labels, members] = await Promise.all([
		client.listWorkItems<RawItem>(facts.projectId),
		client.listArchivedWorkItems<RawItem>(facts.projectId),
		client.listStates<RawState>(facts.projectId),
		client.listLabels<RawLabel>(facts.projectId),
		client.listWorkspaceMembers<RawMember>(),
	]);
	if (archived === null) {
		throw new ReplicateError(
			"Verify cannot prove live+archived set equality: the target archived-items endpoint is unavailable.",
		);
	}
	const archivedIds = new Set(archived.map((item) => item.id));
	const targetItems = [...new Map([...live, ...archived].map((item) => [item.id, item])).values()];
	const targetById = new Map(targetItems.map((item) => [item.id, item]));

	for (const source of snapshot.items) {
		const mapped = facts.targetBySource.get(source.id);
		if (!mapped) {
			add(itemFinding("set-equality", "failure", source, undefined, "Journal mapping is missing"));
			continue;
		}
		const target = targetById.get(mapped.id);
		if (!target) {
			add(
				itemFinding("set-equality", "failure", source, mapped.id, "Mapped target item is missing"),
			);
			continue;
		}
		if (facts.header.identifierMode === "exact" && target.sequence_id !== source.sequenceId) {
			add(
				itemFinding(
					"set-equality",
					"failure",
					source,
					target.id,
					`Sequence mismatch: expected ${source.sequenceId}, found ${target.sequence_id}`,
				),
			);
		}
	}
	for (const target of targetItems) {
		if (!facts.sourceByTarget.has(target.id)) {
			add({
				check: "set-equality",
				severity: "failure",
				message: `Extra target item ${facts.header.destIdentifier}-${target.sequence_id}`,
				targetItemId: target.id,
			});
		}
	}

	const statesById = new Map(states.map((state) => [state.id, state]));
	const labelsById = new Map(labels.map((label) => [label.id, label]));
	const targetMemberByEmail = new Map(
		members
			.filter((member) => member.email && (member.member ?? member.id))
			.map((member) => [member.email!.toLowerCase(), member.member ?? member.id!]),
	);
	for (const source of snapshot.items) {
		const targetId = facts.targetBySource.get(source.id)?.id;
		const target = targetId ? targetById.get(targetId) : undefined;
		if (!target) continue;
		compareScalars(source, target, archivedIds, snapshot, facts, statesById, labelsById, add);
		compareHtml(
			"description",
			source,
			target,
			source.descriptionHtml,
			target.description_html,
			add,
		);
		compareItemAuthorship(source, target, snapshot, facts.probe, targetMemberByEmail, add, skipped);
		compareAssignees(source, target, snapshot, targetMemberByEmail, add, skipped);
	}

	await compareComments(
		client,
		facts,
		snapshot,
		targetById,
		targetMemberByEmail,
		add,
		skipped,
		options.concurrency,
	);
	await compareRelations(client, facts, snapshot, targetItems, add, options.concurrency);
	const assets = auditAssets(snapshot, client, add);
	if (options.exportFile) compareExport(options.exportFile, targetItems, facts, add);

	const failures = findings.filter((finding) => finding.severity === "failure").length;
	const warnings = findings.length - failures;
	return {
		summary: { failures, warnings, skipped: skipped.length, ok: failures === 0 },
		findings,
		skipped,
		counts: { snapshotItems: snapshot.items.length, targetItems: targetItems.length, assets },
	};
}

function journalFacts(
	entries: JournalEntry[],
	snapshot: ProjectSnapshot,
	client: VerifyClient,
): JournalFacts {
	const header = entries[0];
	if (!header || header.type !== "header") throw new ReplicateError("Verify journal has no header");
	if (header.snapshotDigest !== snapshot.digest) {
		throw new ReplicateError("Verify journal snapshot digest does not match the snapshot");
	}
	if (
		header.target.baseUrl !== client.baseUrl ||
		header.target.workspaceSlug !== client.workspaceSlug
	) {
		throw new ReplicateError("Verify journal target does not match the selected --to context");
	}
	if (!entries.some((entry) => entry.type === "apply-complete")) {
		throw new ReplicateError("Verify journal is incomplete: apply-complete is missing");
	}
	if (entries.some((entry) => entry.type === "poisoned")) {
		throw new ReplicateError("Verify journal is poisoned and cannot establish cutover fidelity");
	}
	const probeEntries = entries.filter((entry) => entry.type === "probe");
	const projectEntries = entries.filter((entry) => entry.type === "project-created");
	if (probeEntries.length !== 1 || projectEntries.length !== 1) {
		throw new ReplicateError(
			"Verify journal must contain exactly one probe and project-created entry",
		);
	}
	if (probeEntries[0]!.probe.dialect !== client.dialect) {
		throw new ReplicateError(
			`Verify client dialect ${client.dialect} does not match journal probe dialect ${probeEntries[0]!.probe.dialect}`,
		);
	}
	const targetBySource = new Map<string, { id: string; seq: number }>();
	const sourceByTarget = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "item-created" || entry.sourceItemId === null) continue;
		if (targetBySource.has(entry.sourceItemId) || sourceByTarget.has(entry.targetItemId)) {
			throw new ReplicateError("Verify journal has duplicate item mappings");
		}
		targetBySource.set(entry.sourceItemId, { id: entry.targetItemId, seq: entry.seq });
		sourceByTarget.set(entry.targetItemId, entry.sourceItemId);
	}
	const snapshotIds = new Set(snapshot.items.map((item) => item.id));
	const missing = snapshot.items.filter((item) => !targetBySource.has(item.id));
	const foreign = [...targetBySource.keys()].filter((id) => !snapshotIds.has(id));
	if (missing.length > 0 || foreign.length > 0) {
		throw new ReplicateError(
			`Verify journal item mapping is incomplete or foreign (${missing.length} missing, ${foreign.length} foreign)`,
		);
	}
	return {
		header,
		probe: probeEntries[0]!.probe,
		projectId: projectEntries[0]!.projectId,
		targetBySource,
		sourceByTarget,
	};
}

function compareScalars(
	source: SnapshotItem,
	target: RawItem,
	archivedIds: Set<string>,
	snapshot: ProjectSnapshot,
	facts: JournalFacts,
	statesById: Map<string, RawState>,
	labelsById: Map<string, RawLabel>,
	add: (finding: VerifyFinding) => void,
): void {
	for (const [field, expected, actual] of [
		["name", source.name, target.name ?? ""],
		["priority", source.priority, target.priority ?? null],
		["point", source.point, typeof target.point === "number" ? target.point : null],
		["start_date", source.startDate, target.start_date ?? null],
		["target_date", source.targetDate, target.target_date ?? null],
		["external_source", source.externalSource, target.external_source ?? null],
		["external_id", source.externalId, target.external_id ?? null],
		["archived", source.archived, archivedIds.has(target.id)],
	] as const) {
		if (expected !== actual) {
			add(
				itemFinding(
					"scalar-fields",
					"failure",
					source,
					target.id,
					`${field}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
				),
			);
		}
	}
	const sourceState = snapshot.states.find((state) => state.id === source.stateId);
	const targetStateId = referenceId(target.state);
	const targetState = targetStateId ? statesById.get(targetStateId) : undefined;
	if ((sourceState?.name ?? null) !== (targetState?.name ?? null)) {
		add(itemFinding("state", "failure", source, target.id, "State name mismatch"));
	}
	if ((sourceState?.group ?? null) !== (targetState?.group ?? null)) {
		add(itemFinding("state", "failure", source, target.id, "State group mismatch"));
	}
	if (sourceState && targetState && sourceState.color !== (targetState.color ?? "")) {
		add(itemFinding("state", "warning", source, target.id, "State color was normalized"));
	}
	const expectedLabels = new Set(
		source.labelIds.map((id) => snapshot.labels.find((label) => label.id === id)?.name ?? `?${id}`),
	);
	const actualLabels = new Set(
		(target.labels ?? []).map((raw) => {
			if (raw && typeof raw === "object" && typeof (raw as RawLabel).name === "string") {
				return (raw as RawLabel).name!;
			}
			const id = referenceId(raw);
			return id ? (labelsById.get(id)?.name ?? `?${id}`) : "?";
		}),
	);
	if (!sameSet(expectedLabels, actualLabels)) {
		add(itemFinding("labels", "failure", source, target.id, "Label name set differs"));
	}
	const expectedParent = source.parentId
		? (facts.targetBySource.get(source.parentId)?.id ?? `missing:${source.parentId}`)
		: null;
	if (expectedParent !== referenceId(target.parent)) {
		add(itemFinding("parent", "failure", source, target.id, "Parent mapping differs"));
	}
}

function compareItemAuthorship(
	source: SnapshotItem,
	target: RawItem,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	targetMemberByEmail: Map<string, string>,
	add: (finding: VerifyFinding) => void,
	skipped: VerifySkipped[],
): void {
	if (probe.createdAtAccepted === true && source.createdAt !== null) {
		if (!sameNullableInstant(source.createdAt, target.created_at ?? null)) {
			add(itemFinding("authorship", "failure", source, target.id, "created_at differs"));
		}
	} else {
		skipped.push({
			check: "authorship",
			field: "item.created_at",
			message:
				source.createdAt === null
					? "Source item has no created_at to verify"
					: "Target probe did not accept item created_at",
			sourceItemId: source.id,
		});
	}
	if (probe.createdByAccepted === true) {
		const expected = mappedCreator(source.createdBy, snapshot, targetMemberByEmail);
		if (source.createdBy !== null && expected === null) {
			skipped.push({
				check: "authorship",
				field: "item.created_by",
				message: "Source author email has no target workspace member mapping",
				sourceItemId: source.id,
			});
		} else if (source.createdBy !== null && expected !== (target.created_by ?? null)) {
			add(itemFinding("authorship", "failure", source, target.id, "created_by differs"));
		}
	} else {
		skipped.push({
			check: "authorship",
			field: "item.created_by",
			message: "Target probe did not accept item created_by",
			sourceItemId: source.id,
		});
	}
}

function compareAssignees(
	source: SnapshotItem,
	target: RawItem,
	snapshot: ProjectSnapshot,
	targetMemberByEmail: Map<string, string>,
	add: (finding: VerifyFinding) => void,
	skipped: VerifySkipped[],
): void {
	const expected = new Set<string>();
	for (const sourceId of source.assigneeIds) {
		const mapped = mappedCreator(sourceId, snapshot, targetMemberByEmail);
		if (mapped) {
			expected.add(mapped);
		} else {
			skipped.push({
				check: "assignees",
				field: "item.assignees",
				message: `Source assignee ${sourceId} has no target workspace member mapping`,
				sourceItemId: source.id,
			});
		}
	}
	const actual = new Set(
		(target.assignees ?? []).map(referenceId).filter((id): id is string => id !== null),
	);
	if (!sameSet(expected, actual)) {
		add(itemFinding("assignees", "failure", source, target.id, "Assignee member set differs"));
	}
}

function compareHtml(
	check: string,
	source: SnapshotItem,
	target: RawItem | RawComment,
	expected: string | null,
	actual: string | null | undefined,
	add: (finding: VerifyFinding) => void,
): void {
	const actualValue = actual ?? null;
	if (expected === null && actualValue === null) return;
	if (
		(expected === null && isEmptyHtml(actualValue)) ||
		(actualValue === null && isEmptyHtml(expected))
	) {
		add(itemFinding(check, "warning", source, target.id, "Null and empty HTML differ"));
		return;
	}
	if (expected !== null && actualValue !== null) {
		if (normalizeHtmlForCompare(expected) === normalizeHtmlForCompare(actualValue)) return;
		if (htmlToMarkdown(expected) === htmlToMarkdown(actualValue)) {
			add(
				itemFinding(check, "warning", source, target.id, "markup transformed, text content equal"),
			);
			return;
		}
	}
	add(itemFinding(check, "failure", source, target.id, "HTML and markdown content differ"));
}

async function compareComments(
	client: VerifyClient,
	facts: JournalFacts,
	snapshot: ProjectSnapshot,
	targetById: Map<string, RawItem>,
	targetMemberByEmail: Map<string, string>,
	add: (finding: VerifyFinding) => void,
	skipped: VerifySkipped[],
	concurrency = 4,
): Promise<void> {
	const mapped = snapshot.items.filter((item) => {
		const targetId = facts.targetBySource.get(item.id)?.id;
		return targetId !== undefined && targetById.has(targetId);
	});
	const sweep = await sweepFetch(
		mapped,
		(item) =>
			client.listWorkItemComments<RawComment>(
				facts.projectId,
				facts.targetBySource.get(item.id)!.id,
			),
		concurrency,
	);
	if (sweep.failures.length > 0) {
		throw new ReplicateError(
			`Verify incomplete: comment fetch failed for ${sweep.failures.length} item(s) after the paced sweep`,
		);
	}
	for (const { item, value: targetComments } of sweep.results) {
		const sourceComments = snapshot.comments[item.id] ?? [];
		if (sourceComments.length !== targetComments.length) {
			add(
				itemFinding(
					"comments",
					"failure",
					item,
					facts.targetBySource.get(item.id)!.id,
					`Comment count: expected ${sourceComments.length}, found ${targetComments.length}`,
				),
			);
		}
		for (const comment of sourceComments) {
			const matches = matchComments(comment, targetComments, facts.probe);
			if (matches.length !== 1) {
				add(
					itemFinding(
						"comments",
						"failure",
						item,
						facts.targetBySource.get(item.id)!.id,
						`Comment ${comment.id} matched ${matches.length} target comments`,
					),
				);
				continue;
			}
			const target = matches[0]!;
			compareHtml(
				"comments",
				item,
				target,
				comment.commentHtml,
				stripCommentFooter(target.comment_html ?? ""),
				add,
			);
			compareCommentAuthorship(
				item,
				comment,
				target,
				snapshot,
				facts.probe,
				targetMemberByEmail,
				add,
				skipped,
			);
		}
	}
}

function matchComments(
	source: SnapshotComment,
	targets: RawComment[],
	probe: TargetProbeResult,
): RawComment[] {
	if (probe.commentCreatedAtAccepted === true && source.createdAt !== null) {
		return targets.filter((target) =>
			sameNullableInstant(source.createdAt, target.created_at ?? null),
		);
	}
	const marker = `data-psrepl-comment="${source.id.replace(/[&<>"']/g, escapeHtmlChar)}"`;
	return targets.filter((target) => (target.comment_html ?? "").includes(marker));
}

function compareCommentAuthorship(
	item: SnapshotItem,
	source: SnapshotComment,
	target: RawComment,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	targetMemberByEmail: Map<string, string>,
	add: (finding: VerifyFinding) => void,
	skipped: VerifySkipped[],
): void {
	if (probe.commentCreatedAtAccepted === true) {
		if (!sameNullableInstant(source.createdAt, target.created_at ?? null)) {
			add(itemFinding("authorship", "failure", item, target.id, "Comment created_at differs"));
		}
	} else {
		skipped.push({
			check: "authorship",
			field: "comment.created_at",
			message: `Target probe did not accept comment created_at (${source.id})`,
			sourceItemId: item.id,
		});
	}
	if (probe.commentCreatedByAccepted === true) {
		const expected = mappedCreator(source.createdBy, snapshot, targetMemberByEmail);
		if (source.createdBy !== null && expected === null) {
			skipped.push({
				check: "authorship",
				field: "comment.created_by",
				message: `Source author email has no target workspace member mapping (${source.id})`,
				sourceItemId: item.id,
			});
		} else if (
			source.createdBy !== null &&
			expected !== (target.created_by ?? target.actor ?? null)
		) {
			add(itemFinding("authorship", "failure", item, target.id, "Comment created_by differs"));
		}
	} else {
		skipped.push({
			check: "authorship",
			field: "comment.created_by",
			message: `Target probe did not accept comment created_by (${source.id})`,
			sourceItemId: item.id,
		});
	}
}

async function compareRelations(
	client: VerifyClient,
	facts: JournalFacts,
	snapshot: ProjectSnapshot,
	targetItems: RawItem[],
	add: (finding: VerifyFinding) => void,
	concurrency = 4,
): Promise<void> {
	const sweep = await sweepFetch(
		targetItems,
		(item) => client.getRelations(facts.projectId, item.id),
		concurrency,
	);
	if (sweep.failures.length > 0) {
		throw new ReplicateError(
			`Verify incomplete: relation fetch failed for ${sweep.failures.length} item(s) after the paced sweep`,
		);
	}
	const targetRelations: ProjectSnapshot["relations"] = {};
	for (const { item, value } of sweep.results) {
		const sourceFrom = facts.sourceByTarget.get(item.id);
		if (!sourceFrom) continue;
		for (const [kind, refs] of Object.entries(value)) {
			for (const ref of refs as unknown[]) {
				const targetTo = referenceId(ref);
				const sourceTo = targetTo ? facts.sourceByTarget.get(targetTo) : undefined;
				if (!targetTo || !sourceTo) {
					throw new ReplicateError(
						`Verify cannot map ${kind} relation reference on target item ${item.id}`,
					);
				}
				let relations = targetRelations[sourceFrom];
				if (!relations) {
					relations = {};
					targetRelations[sourceFrom] = relations;
				}
				const relationKind = kind as keyof typeof relations;
				let related = relations[relationKind];
				if (!related) {
					related = [];
					relations[relationKind] = related;
				}
				related.push(sourceTo);
			}
		}
	}
	const expected = new Map(canonicalRelations(snapshot).map((edge) => [edge.key, edge]));
	const targetSnapshot = { ...snapshot, relations: targetRelations };
	const actual = new Map(canonicalRelations(targetSnapshot).map((edge) => [edge.key, edge]));
	const accepted = new Set(facts.probe.relationKindsAccepted ?? []);
	for (const [key, edge] of expected) {
		if (actual.has(key)) continue;
		add({
			check: "relations",
			severity: accepted.has(edge.kind) ? "failure" : "warning",
			message: accepted.has(edge.kind)
				? `Missing relation ${key}`
				: `Known degradation: target probe rejected relation kind ${edge.kind}`,
			sourceItemId: edge.lowerId,
		});
	}
	for (const [key, edge] of actual) {
		if (!expected.has(key)) {
			add({
				check: "relations",
				severity: "failure",
				message: `Extra target relation ${key}`,
				sourceItemId: edge.lowerId,
			});
		}
	}
}

function auditAssets(
	snapshot: ProjectSnapshot,
	client: VerifyClient,
	add: (finding: VerifyFinding) => void,
): VerifyCounts["assets"] {
	const counts = { sourceInstance: 0, target: 0, other: 0 };
	const sourceHosts = hosts(snapshot.source.baseUrl);
	const targetHosts = hosts(client.baseUrl);
	for (const item of snapshot.items) {
		let sourceLinks = 0;
		const html = [
			item.descriptionHtml ?? "",
			...(snapshot.comments[item.id] ?? []).map((c) => c.commentHtml),
		];
		for (const chunk of html) {
			for (const match of chunk.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
				try {
					const host = new URL(match[1]!).host.toLowerCase();
					if (sourceHosts.has(host)) {
						counts.sourceInstance++;
						sourceLinks++;
					} else if (targetHosts.has(host)) {
						counts.target++;
					} else {
						counts.other++;
					}
				} catch {
					counts.other++;
				}
			}
		}
		if (sourceLinks > 0) {
			add(
				itemFinding(
					"asset-links",
					"warning",
					item,
					undefined,
					`${sourceLinks} URL(s) still point at the source instance`,
				),
			);
		}
	}
	return counts;
}

function compareExport(
	path: string,
	targetItems: RawItem[],
	facts: JournalFacts,
	add: (finding: VerifyFinding) => void,
): void {
	const parsed = parseMarkdownFile(readFileSync(path, "utf8"), path);
	const byIdentifier = new Map(
		targetItems.map((item) => [
			`${facts.header.destIdentifier}-${item.sequence_id}`.toUpperCase(),
			item,
		]),
	);
	for (const story of parsed.stories) {
		if (!story.planeIdentifier) continue;
		const target = byIdentifier.get(story.planeIdentifier.toUpperCase());
		if (!target) {
			add({
				check: "export-file",
				severity: "warning",
				message: `Export identifier ${story.planeIdentifier} is absent from the target`,
				identifier: story.planeIdentifier,
			});
		} else if (story.title !== (target.name ?? "")) {
			add({
				check: "export-file",
				severity: "warning",
				message: `Export title for ${story.planeIdentifier} differs from target name`,
				identifier: story.planeIdentifier,
				targetItemId: target.id,
			});
		}
	}
}

export function formatVerifyReport(report: VerifyReport, json = false): string {
	if (json) return JSON.stringify(report, null, 2);
	const lines = [
		`Verify: ${report.summary.failures} failure(s), ${report.summary.warnings} warning(s), ${report.summary.skipped} skipped check(s)`,
		`Items: snapshot ${report.counts.snapshotItems}, target ${report.counts.targetItems}`,
		`Links: source ${report.counts.assets.sourceInstance}, target ${report.counts.assets.target}, other ${report.counts.assets.other}`,
	];
	const grouped = new Map<string, VerifyFinding[]>();
	for (const finding of report.findings) {
		const list = grouped.get(finding.check) ?? [];
		list.push(finding);
		grouped.set(finding.check, list);
	}
	let remaining = 50;
	let shown = 0;
	for (const [check, values] of grouped) {
		lines.push(`\n${check} (${values.length})`);
		for (const finding of values.slice(0, remaining)) {
			lines.push(`  ${finding.severity.toUpperCase()}: ${finding.message}`);
		}
		const added = Math.min(values.length, remaining);
		remaining -= added;
		shown += added;
		if (remaining === 0) break;
	}
	if (remaining > 0 && report.skipped.length > 0) {
		lines.push(`\nskipped checks (${report.skipped.length})`);
		for (const entry of report.skipped.slice(0, remaining)) {
			lines.push(`  SKIPPED: ${entry.field}: ${entry.message}`);
		}
		const added = Math.min(report.skipped.length, remaining);
		remaining -= added;
		shown += added;
	}
	const totalDetails = report.findings.length + report.skipped.length;
	if (totalDetails > shown) lines.push(`  +${totalDetails - shown} more`);
	return lines.join("\n");
}

function itemFinding(
	check: string,
	severity: VerifySeverity,
	source: SnapshotItem,
	targetItemId: string | undefined,
	message: string,
): VerifyFinding {
	return { check, severity, message, sourceItemId: source.id, targetItemId };
}

function referenceId(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value !== null && typeof value === "object") {
		for (const key of ["issue_id", "id", "member"]) {
			const candidate = (value as Record<string, unknown>)[key];
			if (typeof candidate === "string") return candidate;
		}
	}
	return null;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every((value) => b.has(value));
}

function sameNullableInstant(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return Date.parse(a) === Date.parse(b);
}

function mappedCreator(
	sourceId: string | null,
	snapshot: ProjectSnapshot,
	targetMemberByEmail: Map<string, string>,
): string | null {
	if (sourceId === null) return null;
	const email = snapshot.members.find((member) => member.id === sourceId)?.email;
	return email ? (targetMemberByEmail.get(email.toLowerCase()) ?? null) : null;
}

function isEmptyHtml(html: string | null): boolean {
	return html !== null && htmlToMarkdown(html) === "";
}

function stripCommentFooter(html: string): string {
	return html
		.replace(/<p\b[^>]*\bdata-psrepl-comment=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/p>\s*$/i, "")
		.trim();
}

function escapeHtmlChar(char: string): string {
	return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!;
}

function hosts(baseUrl: string): Set<string> {
	const out = new Set<string>();
	for (const value of [baseUrl, deriveWebBaseUrl(baseUrl)]) {
		try {
			out.add(new URL(value).host.toLowerCase());
		} catch {
			// Snapshot parsing already validates the digest, but older snapshots may
			// contain an unusual base URL. Such links simply classify as "other".
		}
	}
	return out;
}
