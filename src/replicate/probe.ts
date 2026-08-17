import { PlaneApiError, ReplicateError } from "../errors.ts";
import type {
	PlaneEndpointDialect,
	PlaneIssueRelations,
	PlaneRelationKind,
} from "../plane/client.ts";
import { isTransientPlaneError } from "./create.ts";

export interface ProbeClient {
	readonly dialect: PlaneEndpointDialect;
	listProjects<T>(): Promise<T[]>;
	listWorkspaceMembers<T>(): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	createProject<T>(body: Record<string, unknown>, opts?: { maxRetries?: number }): Promise<T>;
	deleteProject(projectId: string): Promise<void>;
	createWorkItem<T>(
		projectId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T>;
	getWorkItem<T>(projectId: string, workItemId: string): Promise<T>;
	deleteWorkItem(projectId: string, workItemId: string): Promise<void>;
	listWorkItems<T>(
		projectId: string,
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T[]>;
	createState<T>(projectId: string, body: Record<string, unknown>): Promise<T>;
	updateState<T>(projectId: string, stateId: string, body: Record<string, unknown>): Promise<T>;
	createRelation(
		projectId: string,
		workItemId: string,
		relationType: PlaneRelationKind,
		issues: string[],
	): Promise<void>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
	archiveWorkItem(projectId: string, workItemId: string): Promise<void>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	createWorkItemComment<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T>;
	listWorkItemComments<T>(projectId: string, workItemId: string): Promise<T[]>;
}

export interface TargetProbeResult {
	dialect: PlaneEndpointDialect;
	identifierAvailable: boolean;
	/** No other project already holds the destination NAME (Plane rejects duplicates with 409). */
	nameAvailable?: boolean;
	/**
	 * Sequence ids already present in the destination project, or null when the
	 * destination does not exist. UNDEFINED means "could not enumerate" — the gate
	 * must fail closed on that rather than assume emptiness.
	 */
	targetSequenceIds?: number[] | null;
	/** False when the destination's archived items could not be listed (a divergence blind spot). */
	targetArchivedEnumerable?: boolean;
	existingProjectId: string | null;
	memberByEmail: Record<string, string>;
	sequencesMaxEver: boolean | null;
	createdAtAccepted: boolean | null;
	createdByAccepted: boolean | null;
	commentCreatedAtAccepted: boolean | null;
	commentCreatedByAccepted: boolean | null;
	relationKindsAccepted: string[] | null;
	archiveVerbAccepted: boolean | null;
	stateWriteAccepted: boolean | null;
}

interface RawProject {
	id: string;
	identifier?: string;
	name?: string;
}

interface RawMember {
	id?: string;
	member?: string;
	email?: string;
}

interface RawItem {
	id: string;
	sequence_id: number;
	created_at?: string | null;
	created_by?: string | null;
	archived_at?: string | null;
}

interface RawComment {
	id: string;
	comment_html?: string;
	created_at?: string | null;
	created_by?: string | null;
	actor?: string | null;
}

/**
 * Determine which endpoint dialect serves an instance's FULL work-item surface.
 * Observed live (operator's CE, 2026-08-09): `/issues/` serves items and
 * comments but 404s the RELATIONS endpoints, which exist only under
 * `/work-items/` there — so a partial surface is a real failure mode, and the
 * relations endpoint is the discriminator. `/issues/` is preferred whenever it
 * serves fully (the whole tool is proven against it; cloud still serves it);
 * `/work-items/` is the fallback. Runs inside a throwaway project, always
 * deleted.
 */
export async function detectDialect(
	factory: (dialect: PlaneEndpointDialect) => ProbeClient,
	opts: EmpiricalProbeOptions = {},
): Promise<PlaneEndpointDialect> {
	const primary = factory("issues");
	let projectId: string | null = null;
	let failure: unknown;
	let verdict: PlaneEndpointDialect | null = null;
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			const suffix = (opts.randomDigits ?? randomFourDigits)();
			try {
				// maxRetries 0: a blind retry of an ambiguous create would leave TWO
				// temp projects (one leaked silently). Aborting leaks at most one,
				// visibly.
				const project = await primary.createProject<RawProject>(
					{ name: "planestories dialect probe", identifier: `PSDLT${suffix}` },
					{ maxRetries: 0 },
				);
				projectId = project.id;
				break;
			} catch (error) {
				if (!isIdentifierConflict(error) || attempt === 3) throw error;
			}
		}
		if (!projectId)
			throw new ReplicateError("Dialect probe could not create its temporary project");
		verdict = (await dialectServesFully(primary, projectId)) ? "issues" : null;
		if (!verdict) {
			const alt = factory("work-items");
			verdict = (await dialectServesFully(alt, projectId)) ? "work-items" : null;
		}
		if (!verdict) {
			throw new ReplicateError(
				"Neither the /issues/ nor the /work-items/ path family serves the full work-item " +
					"surface (items + relations) on this instance — cannot replicate against it.",
			);
		}
	} catch (error) {
		failure = error;
	} finally {
		if (projectId) {
			try {
				await primary.deleteProject(projectId);
			} catch (cleanupError) {
				const message =
					`Dialect probe could not delete temporary project ${projectId}; remove it manually: ` +
					describeError(cleanupError);
				opts.warn?.(message);
				failure = failure
					? new ReplicateError(`${describeError(failure)}; additionally, ${message}`)
					: new ReplicateError(message);
			}
		}
	}
	if (failure) throw failure;
	if (!verdict) throw new ReplicateError("Dialect probe reached an impossible state");
	return verdict;
}

/** The read surface a SOURCE-side dialect check needs (zero writes). */
export interface ReadDialectClient {
	readonly dialect: PlaneEndpointDialect;
	listWorkItems<T>(
		projectId: string,
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T[]>;
	listArchivedWorkItems<T>(projectId: string): Promise<T[] | null>;
	getRelations(projectId: string, workItemId: string): Promise<PlaneIssueRelations>;
}

/**
 * Read-only dialect detection for the SNAPSHOT side: a snapshot must not write
 * to the source, so the discriminator is the source project's own items — live
 * first, then ARCHIVED (an archived-only project must not be misread as empty:
 * its relation reads would later abort under the wrong family). A dialect with
 * no observable item is inconclusive, not chosen — only a genuinely empty
 * project (no evidence under any dialect) falls back to the first family that
 * listed, where relations are vacuous anyway.
 */
export async function detectSourceDialect(
	factory: (dialect: PlaneEndpointDialect) => ReadDialectClient,
	projectId: string,
): Promise<PlaneEndpointDialect> {
	let emptyFallback: PlaneEndpointDialect | null = null;
	for (const dialect of ["issues", "work-items"] as const) {
		const client = factory(dialect);
		let live: Array<{ id: string }>;
		try {
			live = await client.listWorkItems<{ id: string }>(projectId);
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
		let probeItem = live[0] ?? null;
		if (!probeItem) {
			const archived = await client.listArchivedWorkItems<{ id: string }>(projectId);
			probeItem = archived?.[0] ?? null;
		}
		if (!probeItem) {
			emptyFallback ??= dialect;
			continue;
		}
		try {
			await client.getRelations(projectId, probeItem.id);
			return dialect;
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
	}
	if (emptyFallback) return emptyFallback;
	throw new ReplicateError(
		"Neither the /issues/ nor the /work-items/ path family serves the full read surface " +
			"(items + relations) for this project — cannot snapshot it.",
	);
}

/** Full surface = item create AND the relations endpoint respond under this dialect. */
async function dialectServesFully(client: ProbeClient, projectId: string): Promise<boolean> {
	let item: RawItem;
	try {
		item = await client.createWorkItem<RawItem>(
			projectId,
			{ name: `dialect-${client.dialect}` },
			{ maxRetries: 0 },
		);
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
	try {
		await client.getRelations(projectId, item.id);
		return true;
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof PlaneApiError && error.status === 404;
}

export async function probeTargetReadOnly(
	client: ProbeClient,
	destIdentifier: string,
	destName?: string,
): Promise<TargetProbeResult> {
	const [projects, members] = await Promise.all([
		client.listProjects<RawProject>(),
		client.listWorkspaceMembers<RawMember>(),
	]);
	const existing = projects.find(
		(project) => project.identifier?.toLowerCase() === destIdentifier.toLowerCase(),
	);
	// Plane rejects a duplicate project NAME with its own 409, independently of the
	// identifier. Freeing only the identifier leaves the apply to die mid-flight on a
	// raw API error instead of failing closed here with every other precondition.
	const nameHolder = destName
		? projects.find((project) => project.name === destName && project.id !== (existing?.id ?? null))
		: undefined;
	const memberByEmail: Record<string, string> = {};
	for (const member of members) {
		const id = member.member ?? member.id;
		if (id && member.email) memberByEmail[member.email.toLowerCase()] = id;
	}
	// Enumerate what the destination already holds so the gate can detect divergence.
	// undefined = "could not enumerate" (the gate fails closed on that); null = no
	// destination project at all.
	let targetSequenceIds: number[] | null | undefined;
	let targetArchivedEnumerable = true;
	if (!existing) {
		targetSequenceIds = null;
	} else {
		try {
			const live = await client.listWorkItems<{ sequence_id?: number }>(existing.id);
			const archivedList = await client.listArchivedWorkItems<{ sequence_id?: number }>(
				existing.id,
			);
			// null = the instance does not serve an archived list (always true on some
			// self-hosted versions). Comparing the live items is still worth doing, but
			// the blind spot is recorded so the gate can say it out loud rather than
			// implying a complete inventory.
			targetArchivedEnumerable = archivedList !== null;
			const archived = archivedList ?? [];
			targetSequenceIds = [...live, ...archived]
				.map((item) => item.sequence_id)
				.filter((sequenceId): sequenceId is number => typeof sequenceId === "number");
		} catch {
			targetSequenceIds = undefined;
		}
	}

	return {
		dialect: client.dialect,
		identifierAvailable: !existing,
		nameAvailable: !nameHolder,
		targetSequenceIds,
		targetArchivedEnumerable,
		existingProjectId: existing?.id ?? null,
		memberByEmail,
		sequencesMaxEver: null,
		createdAtAccepted: null,
		createdByAccepted: null,
		commentCreatedAtAccepted: null,
		commentCreatedByAccepted: null,
		relationKindsAccepted: null,
		archiveVerbAccepted: null,
		stateWriteAccepted: null,
	};
}

export interface EmpiricalProbeOptions {
	randomDigits?: () => string;
	warn?: (message: string) => void;
}

/** Run all write capability checks inside one project created by this call. */
export async function probeTargetEmpirical(
	client: ProbeClient,
	base: TargetProbeResult,
	needs: { relationKinds: string[]; archived: boolean; anyComments: boolean },
	opts: EmpiricalProbeOptions = {},
): Promise<TargetProbeResult> {
	const result: TargetProbeResult = { ...base };
	let projectId: string | null = null;
	let failure: unknown;
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			const suffix = (opts.randomDigits ?? randomFourDigits)();
			try {
				// Plain words only: some instances (observed on the operator's CE)
				// reject project names containing special characters.
				const project = await client.createProject<RawProject>(
					{ name: "planestories temporary probe", identifier: `PSPRB${suffix}` },
					{ maxRetries: 0 },
				);
				projectId = project.id;
				break;
			} catch (error) {
				if (!isIdentifierConflict(error) || attempt === 3) throw error;
			}
		}
		if (!projectId) throw new ReplicateError("Target probe could not create its temporary project");

		// Relative arithmetic, not absolute numbers: the verdict must not depend
		// on the temp project starting at sequence 1 (any concurrent oddity would
		// otherwise read as a false non-max-ever and fail the gate spuriously).
		const p1 = await createProbeItem(client, projectId, "P1");
		const p2 = await createProbeItem(client, projectId, "P2");
		await client.deleteWorkItem(projectId, p2.id);
		const p3 = await createProbeItem(client, projectId, "P3");
		let maxEver = p3.sequence_id === p2.sequence_id + 1;
		await client.deleteWorkItem(projectId, p1.id);
		const p4 = await createProbeItem(client, projectId, "P4");
		maxEver = maxEver && p4.sequence_id === p3.sequence_id + 1;
		result.sequencesMaxEver = maxEver;

		// Known limitation: on a single-member workspace the only probe-able
		// member may BE the API key's owner, whom the server would stamp anyway —
		// created_by acceptance can then read true even if the field is ignored.
		// Harmless today (the mapped author equals the stamped one), but a
		// multi-member target gives the probe real discriminating power.
		const createdAt = "2020-01-02T03:04:05Z";
		const memberId = Object.values(base.memberByEmail)[0];
		const fidelityBody: Record<string, unknown> = { name: "fidelity" };
		fidelityBody.created_at = createdAt;
		if (memberId) fidelityBody.created_by = memberId;
		const fidelity = await client.createWorkItem<RawItem>(projectId, fidelityBody, {
			maxRetries: 0,
		});
		const fetched = await client.getWorkItem<RawItem>(projectId, fidelity.id);
		result.createdAtAccepted = sameInstant(fetched.created_at, createdAt);
		result.createdByAccepted = memberId ? fetched.created_by === memberId : false;

		if (needs.anyComments) {
			const commentBody: Record<string, unknown> = {
				comment_html: "<p>planestories probe</p>",
				created_at: createdAt,
			};
			if (memberId) commentBody.created_by = memberId;
			const created = await client.createWorkItemComment<RawComment>(
				projectId,
				fidelity.id,
				commentBody,
				{ maxRetries: 0 },
			);
			const comments = await client.listWorkItemComments<RawComment>(projectId, fidelity.id);
			const found = comments.find((comment) => comment.id === created.id) ?? created;
			result.commentCreatedAtAccepted = sameInstant(found.created_at, createdAt);
			result.commentCreatedByAccepted = memberId
				? (found.created_by ?? found.actor) === memberId
				: false;
		}

		const accepted: string[] = [];
		for (const kind of [...new Set(needs.relationKinds)].sort()) {
			try {
				await client.createRelation(projectId, p3.id, kind as PlaneRelationKind, [p4.id]);
				accepted.push(kind);
			} catch (error) {
				if (isTransientPlaneError(error) || !isPermanent4xx(error)) throw error;
			}
		}
		result.relationKindsAccepted = accepted;

		if (needs.archived) {
			try {
				await client.archiveWorkItem(projectId, p4.id);
				const archived = await client.listArchivedWorkItems<RawItem>(projectId);
				if (archived === null) {
					const item = await client.getWorkItem<RawItem>(projectId, p4.id);
					result.archiveVerbAccepted = item.archived_at != null;
				} else {
					result.archiveVerbAccepted = archived.some((item) => item.id === p4.id);
				}
			} catch (error) {
				if (isTransientPlaneError(error) || !isPermanent4xx(error)) throw error;
				result.archiveVerbAccepted = false;
			}
		}

		try {
			const state = await client.createState<{ id: string }>(projectId, {
				name: "psprobe",
				group: "backlog",
				color: "#123456",
			});
			await client.updateState(projectId, state.id, { color: "#654321" });
			result.stateWriteAccepted = true;
		} catch (error) {
			if (isTransientPlaneError(error) || !isPermanent4xx(error)) throw error;
			result.stateWriteAccepted = false;
		}
	} catch (error) {
		failure = error;
	} finally {
		if (projectId) {
			try {
				await client.deleteProject(projectId);
			} catch (cleanupError) {
				const message =
					`Target probe could not delete temporary project ${projectId}; remove it manually: ` +
					describeError(cleanupError);
				opts.warn?.(message);
				failure = failure
					? new ReplicateError(`${describeError(failure)}; additionally, ${message}`)
					: new ReplicateError(message);
			}
		}
	}
	if (failure) throw failure;
	return result;
}

async function createProbeItem(client: ProbeClient, projectId: string, name: string) {
	return client.createWorkItem<RawItem>(projectId, { name }, { maxRetries: 0 });
}

function randomFourDigits(): string {
	return String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
}

function sameInstant(actual: string | null | undefined, expected: string): boolean {
	return actual != null && Date.parse(actual) === Date.parse(expected);
}

function isPermanent4xx(error: unknown): boolean {
	return (
		error instanceof PlaneApiError &&
		error.status !== undefined &&
		error.status >= 400 &&
		error.status < 500
	);
}

function isIdentifierConflict(error: unknown): boolean {
	return (
		isPermanent4xx(error) && /identifier|already|exist|unique|conflict/i.test(describeError(error))
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
