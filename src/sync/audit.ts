import { sweepFetch } from "../utils/sweep.ts";

export const DEFAULT_AUDIT_SINCE = "24h";

export interface AuditWindow {
	requested: string;
	since: string;
	through: string;
}

export interface AuditActor {
	id: string;
	displayName: string | null;
	email: string | null;
}

export interface AuditWrite {
	/** Full API base URL: the instance identity must travel on every row. */
	instance: string;
	identifier: string;
	title: string;
	verb: string | null;
	field: string | null;
	when: string;
	activityId: string | null;
}

export interface AuditScan {
	actor: AuditActor;
	window: AuditWindow;
	cachedItemCount: number;
	walkedItemCount: number;
	writes: AuditWrite[];
}

export interface AuditProvenance {
	instance: string;
	workspaceSlug: string;
	project: string;
	projectId: string;
	cacheFetchedAt: string;
	cacheAgeMs: number;
}

export interface AuditReport extends AuditScan {
	provenance: AuditProvenance;
	limits: {
		attribution: string;
		window: string;
		candidateNarrowing: string;
	};
}

export interface AuditClient {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	concurrency?(): number | undefined;
	getCurrentUser<T>(): Promise<T>;
	listWorkItemActivities<T>(projectId: string, workItemId: string): Promise<T[]>;
}

/** Minimal cached evidence needed to decide which live activity trails to walk. */
export interface AuditCandidateItem {
	id: string;
	identifier: string;
	title: string;
	updatedAt: string | null;
}

/** Refusal: widening to all actors would answer a different question. */
export class AuditActorResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditActorResolutionError";
	}
}

/** Refusal: the cached timestamps cannot safely narrow the per-item sweep. */
export class AuditBoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditBoundError";
	}
}

/** Refusal: a partial or suspiciously empty activity sweep is not an answer. */
export class AuditReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditReadError";
	}
}

/** Parse `--since` as a compact positive duration or an explicit ISO-8601 instant. */
export function parseAuditWindow(value: string | undefined, now: Date = new Date()): AuditWindow {
	if (Number.isNaN(now.getTime()))
		throw new AuditBoundError("Audit clock returned an invalid date.");
	const requested = value ?? DEFAULT_AUDIT_SINCE;
	const duration = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(requested.trim());
	let sinceMs: number;
	if (duration) {
		const amount = Number(duration[1]);
		const unit = duration[2]?.toLowerCase();
		const multiplier =
			unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
		const milliseconds = amount * multiplier;
		if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
			throw invalidSince(requested);
		}
		sinceMs = now.getTime() - milliseconds;
	} else {
		// Date-only is unambiguously UTC in ECMAScript. Date-times must carry Z or
		// an offset so the same command means the same instant in every timezone.
		const iso =
			/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/i;
		if (!iso.test(requested.trim())) throw invalidSince(requested);
		sinceMs = Date.parse(requested.trim());
		if (Number.isNaN(sinceMs)) throw invalidSince(requested);
	}

	if (!Number.isFinite(sinceMs)) throw invalidSince(requested);
	if (sinceMs > now.getTime()) {
		throw new AuditBoundError(`--since ${JSON.stringify(requested)} is in the future.`);
	}
	return {
		requested,
		since: new Date(sinceMs).toISOString(),
		through: now.toISOString(),
	};
}

/**
 * Resolve the API-key owner, narrow by cached `updatedAt`, then fail-hard fetch
 * activity for only those candidates. Returned activity is independently
 * filtered to the requested window: a recently touched item also returns its
 * older history.
 */
export async function auditWrites(
	client: AuditClient,
	projectId: string,
	items: readonly AuditCandidateItem[],
	window: AuditWindow,
): Promise<AuditScan> {
	const itemTimes = items.map((item) => ({
		item,
		updatedMs: item.updatedAt === null ? Number.NaN : Date.parse(item.updatedAt),
	}));
	const unusableUpdatedAt = itemTimes.filter(({ updatedMs }) => Number.isNaN(updatedMs));
	if (unusableUpdatedAt.length > 0) {
		throw new AuditBoundError(
			`Cannot safely bound the activity walk: ${unusableUpdatedAt.length}/${items.length} cached work item(s) have no usable updatedAt. ` +
				"Refreshing the board cache may restore the timestamps; otherwise only a full per-item activity sweep would answer the question, and audit deliberately never performs one.",
		);
	}

	const sinceMs = Date.parse(window.since);
	const throughMs = Date.parse(window.through);
	if (Number.isNaN(sinceMs) || Number.isNaN(throughMs) || sinceMs > throughMs) {
		throw new AuditBoundError("Audit window is invalid.");
	}
	const futureUpdatedAt = itemTimes.filter(({ updatedMs }) => updatedMs > throughMs);
	if (futureUpdatedAt.length > 0) {
		throw new AuditBoundError(
			`Cannot safely bound the activity walk: ${futureUpdatedAt.length}/${items.length} cached work item(s) have updatedAt after the audit clock (${window.through}). ` +
				"Refresh after checking the local/server clocks; otherwise only a full per-item activity sweep would answer the question, and audit deliberately never performs one.",
		);
	}
	const candidates = itemTimes
		.filter(({ updatedMs }) => updatedMs >= sinceMs)
		.map(({ item }) => item);
	const actor = await resolveActor(client);
	const sweep = await sweepFetch(
		candidates,
		(item) => client.listWorkItemActivities<unknown>(projectId, item.id),
		client.concurrency?.() ?? 4,
	);
	if (sweep.failures.length > 0) {
		const first = sweep.failures[0];
		throw new AuditReadError(
			`Activity lookup failed for ${sweep.failures.length}/${candidates.length} candidate item(s)` +
				`${first ? ` (first: ${describeError(first.error)})` : ""}. No partial audit was emitted; re-run audit when every candidate endpoint is readable.`,
		);
	}

	const totalActivities = sweep.results.reduce((sum, result) => sum + result.value.length, 0);
	if (candidates.length > 0 && totalActivities === 0) {
		throw new AuditReadError(
			`Activity lookup returned no entries at all for ${candidates.length} recently updated candidate item(s). ` +
				"A populated item normally has an activity trail, so this may be an unrecognized API response rather than genuine silence. Refusing to publish an empty audit; verify one candidate's /activities/ endpoint and retry.",
		);
	}

	const writes: AuditWrite[] = [];
	for (const { item, value: activities } of sweep.results) {
		for (const raw of activities) {
			if (!isRecord(raw)) {
				throw new AuditReadError(
					`Activity lookup for ${item.identifier} returned a malformed entry. No partial audit was emitted.`,
				);
			}
			if (raw.actor !== actor.id) continue;
			const createdAt = activityInstant(raw.created_at, item.identifier);
			const createdMs = Date.parse(createdAt);
			if (createdMs < sinceMs || createdMs > throughMs) continue;
			writes.push({
				instance: client.baseUrl,
				identifier: item.identifier,
				title: item.title,
				verb: nullableActivityString(raw.verb, "verb", item.identifier),
				field: nullableActivityString(raw.field, "field", item.identifier),
				when: createdAt,
				activityId: nullableActivityString(raw.id, "id", item.identifier),
			});
		}
	}
	writes.sort(
		(a, b) =>
			b.when.localeCompare(a.when) ||
			(a.activityId ?? a.identifier).localeCompare(b.activityId ?? b.identifier) ||
			a.identifier.localeCompare(b.identifier),
	);

	return {
		actor,
		window,
		cachedItemCount: items.length,
		walkedItemCount: candidates.length,
		writes,
	};
}

/** Add durable board/cache provenance and the three limits that qualify every answer. */
export function buildAuditReport(scan: AuditScan, provenance: AuditProvenance): AuditReport {
	return {
		...scan,
		provenance,
		limits: {
			attribution:
				"Actor is the API key's owner. planestories, the Plane MCP, and that owner's UI actions are indistinguishable; this answers “which writes by me landed on this instance”, not “which tool made them”.",
			window: `This report covers only the --since window ${scan.window.since} through ${scan.window.through}.`,
			candidateNarrowing:
				"The live walk is limited to items whose cached updatedAt falls inside the bound. Plane comment- or relation-only writes need not bump updatedAt, and writes after the cache was fetched may be absent; this is bounded evidence, not a complete activity export.",
		},
	};
}

/** Render an explicit, newest-first human answer; a measured zero keeps its denominator. */
export function formatAuditReport(report: AuditReport): string {
	const actorName = report.actor.displayName ?? report.actor.email ?? report.actor.id;
	const actorEmail =
		report.actor.displayName && report.actor.email ? ` <${report.actor.email}>` : "";
	const lines = [
		`Actor: ${actorName}${actorEmail} · ${report.actor.id}`,
		`Board: ${report.provenance.project} · ${report.provenance.instance} · workspace ${report.provenance.workspaceSlug}`,
		`Cache: fetched ${report.provenance.cacheFetchedAt} · ${formatAge(report.provenance.cacheAgeMs)} old · ${report.cachedItemCount} ${report.cachedItemCount === 1 ? "item" : "items"}`,
		`Bound: --since ${report.window.requested} · ${report.window.since} through ${report.window.through} · walked ${report.walkedItemCount}/${report.cachedItemCount} cached items whose updatedAt was inside the bound`,
		"Limits:",
		`  1. ${report.limits.attribution}`,
		`  2. ${report.limits.window}`,
		`  3. ${report.limits.candidateNarrowing}`,
	];
	if (report.writes.length === 0) {
		lines.push(
			`No matching writes were attributed to this actor among ${report.walkedItemCount} live activity ${report.walkedItemCount === 1 ? "trail" : "trails"} walked.`,
		);
		return lines.join("\n");
	}
	lines.push("Writes (newest first):");
	lines.push("  instance · identifier · title · verb · field · when");
	for (const write of report.writes) {
		lines.push(
			`  ${write.instance} · ${write.identifier} · ${write.title} · ${write.verb ?? "—"} · ${write.field ?? "—"} · ${write.when}`,
		);
	}
	return lines.join("\n");
}

async function resolveActor(client: AuditClient): Promise<AuditActor> {
	let raw: unknown;
	try {
		raw = await client.getCurrentUser<unknown>();
	} catch (error) {
		throw actorResolutionError(client, describeError(error));
	}
	if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim().length === 0) {
		throw actorResolutionError(client, 'the response did not carry a non-empty "id"');
	}
	const first = optionalString(raw.first_name);
	const last = optionalString(raw.last_name);
	const composedName = [first, last].filter((part): part is string => part !== null).join(" ");
	return {
		id: raw.id.trim(),
		displayName: optionalString(raw.display_name) ?? (composedName || null),
		email: optionalString(raw.email),
	};
}

function actorResolutionError(client: AuditClient, detail: string): AuditActorResolutionError {
	const endpoint = `${client.baseUrl.replace(/\/+$/, "")}/api/v1/users/me/`;
	return new AuditActorResolutionError(
		`Refusing to audit because the current API-key owner could not be resolved (${detail}). ` +
			"Audit will not widen to all activity, which would answer a different question. " +
			`A successful authenticated GET ${endpoint} returning a user "id" would answer it; verify with: ` +
			`curl -H 'X-API-Key: <key for this context>' '${endpoint}'`,
	);
}

function activityInstant(value: unknown, identifier: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AuditReadError(
			`An activity attributed to the current actor on ${identifier} has no created_at, so it cannot be placed inside the requested window. No partial audit was emitted.`,
		);
	}
	const milliseconds = Date.parse(value);
	if (Number.isNaN(milliseconds)) {
		throw new AuditReadError(
			`An activity attributed to the current actor on ${identifier} has an invalid created_at (${JSON.stringify(value)}). No partial audit was emitted.`,
		);
	}
	return new Date(milliseconds).toISOString();
}

function nullableActivityString(value: unknown, field: string, identifier: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	throw new AuditReadError(
		`An activity attributed to the current actor on ${identifier} has a non-string ${field}. No partial audit was emitted.`,
	);
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSince(value: string): AuditBoundError {
	return new AuditBoundError(
		`Invalid --since ${JSON.stringify(value)}. Use a positive duration such as 90m, 24h, or 7d, or an ISO-8601 instant with a timezone.`,
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatAge(milliseconds: number): string {
	const minutes = Math.floor(milliseconds / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
