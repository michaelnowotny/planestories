import { PlaneApiError, ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect, PlaneRelationKind } from "../plane/client.ts";
import { isTransientPlaneError } from "./create.ts";

export interface ProbeClient {
	readonly dialect: PlaneEndpointDialect;
	listProjects<T>(): Promise<T[]>;
	listWorkspaceMembers<T>(): Promise<T[]>;
	createProject<T>(body: Record<string, unknown>): Promise<T>;
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

export async function probeTargetReadOnly(
	client: ProbeClient,
	destIdentifier: string,
): Promise<TargetProbeResult> {
	const [projects, members] = await Promise.all([
		client.listProjects<RawProject>(),
		client.listWorkspaceMembers<RawMember>(),
	]);
	const existing = projects.find(
		(project) => project.identifier?.toLowerCase() === destIdentifier.toLowerCase(),
	);
	const memberByEmail: Record<string, string> = {};
	for (const member of members) {
		const id = member.member ?? member.id;
		if (id && member.email) memberByEmail[member.email.toLowerCase()] = id;
	}
	return {
		dialect: client.dialect,
		identifierAvailable: !existing,
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
				const project = await client.createProject<RawProject>({
					name: "planestories probe (temporary)",
					identifier: `PSPRB${suffix}`,
				});
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
