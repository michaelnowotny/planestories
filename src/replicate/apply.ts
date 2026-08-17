import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PlaneApiError, ReplicateError } from "../errors.ts";
import type { PlaneEndpointDialect, PlaneRelationKind } from "../plane/client.ts";
import {
	type A10CreateClient,
	createItemA10,
	type ExpectedIdentity,
	isTransientPlaneError,
	reconcileExpectedItem,
} from "./create.ts";
import { decideGate, type GateFlags } from "./gate.ts";
import { Journal, type JournalEntry, type JournalHeader } from "./journal.ts";
import {
	type ProbeClient,
	probeTargetEmpirical,
	probeTargetReadOnly,
	type TargetProbeResult,
} from "./probe.ts";
import type {
	ApplyManifests,
	IdentifierMode,
	ProjectSnapshot,
	SnapshotComment,
	SnapshotItem,
} from "./types.ts";

export interface ApplyClient extends ProbeClient, A10CreateClient {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	readonly dialect: PlaneEndpointDialect;
	/**
	 * Optional capability (PlaneClient implements it): a sibling client whose
	 * every non-GET HTTP ATTEMPT — including internal retries — first runs
	 * `hook`. When present, the ownership guard uses it so a lock lost during a
	 * retry backoff stops the very next attempt, not just the next method call.
	 */
	withBeforeWriteAttempt?(hook: () => void): ApplyClient;
	getProject<T>(projectId: string): Promise<T>;
	listStates<T>(projectId: string): Promise<T[]>;
	listLabels<T>(projectId: string): Promise<T[]>;
	createLabel<T>(projectId: string, body: Record<string, unknown>): Promise<T>;
	updateLabel<T>(projectId: string, labelId: string, body: Record<string, unknown>): Promise<T>;
	updateWorkItem<T>(
		projectId: string,
		workItemId: string,
		body: Record<string, unknown>,
	): Promise<T>;
}

export interface ApplyOptions {
	yes: boolean;
	destName?: string;
	destIdentifier?: string;
	flags: GateFlags;
	journalPath: string;
	limit?: number;
	onProgress?: (msg: string) => void;
	sleep?: (ms: number) => Promise<void>;
	runId?: string;
	toolVersion: string;
}

export interface ApplyResult {
	mode: IdentifierMode;
	dryRun: boolean;
	projectId: string | null;
	itemsCreated: number;
	itemsSkipped: number;
	placeholdersCreated: number;
	placeholdersDeleted: number;
	parentsSet: number;
	relationsCreated: number;
	commentsCreated: number;
	archivedCount: number;
	manifests: ApplyManifests;
	complete: boolean;
	probe: TargetProbeResult;
}

interface RawProject {
	id: string;
	identifier?: string;
	name?: string;
}

interface RawState {
	id: string;
	name?: string;
	group?: string;
	color?: string;
	description?: string;
	default?: boolean;
}

interface RawLabel {
	id: string;
	name?: string;
	parent?: string | null;
}

interface RawItem {
	id: string;
	sequence_id: number;
	name?: string;
	external_id?: string | null;
	archived_at?: string | null;
}

interface RawComment {
	id: string;
	comment_html?: string;
	created_at?: string | null;
}

export async function applySnapshot(
	client: ApplyClient,
	snapshot: ProjectSnapshot,
	options: ApplyOptions,
): Promise<ApplyResult> {
	const progress = options.onProgress ?? (() => {});
	const destName = options.destName ?? snapshot.project.name;
	const destIdentifier = options.destIdentifier ?? snapshot.project.identifier;
	const initialMode: IdentifierMode = options.flags.noExactIdentifiers ? "renumber" : "exact";

	if (!options.yes) {
		const probe = await probeTargetReadOnly(client, destIdentifier, destName);
		const gate = decideGate({
			snapshot,
			probe,
			flags: options.flags,
			resume: { journalOwnsProject: null },
			destIdentifier,
			destName,
		});
		progress(formatGateProgress(gate.errors, gate.warnings, snapshot, true));
		if (!gate.ok) throw new ReplicateError(gate.errors.join("\n"));
		return emptyResult(gate.mode, true, null, gate.manifests, probe);
	}

	let journal: Journal | null = null;
	try {
		if (existsSync(options.journalPath)) {
			journal = Journal.openOrDiscardTorn(
				options.journalPath,
				{
					snapshotDigest: snapshot.digest,
					targetBaseUrl: client.baseUrl,
					targetWorkspaceSlug: client.workspaceSlug,
				},
				{ warn: options.onProgress },
			);
		}
		if (journal) {
			validateResumeOptions(journal, destName, destIdentifier, initialMode);

			if (options.flags.recreateTarget) {
				// Explicit drop-and-rebuild: delete the run-created project (if any)
				// and retire this journal generation. The run then continues as a
				// fresh one — including a fresh empirical probe of the target.
				await recreateOwnedTarget(ownershipGuardedClient(client, journal), journal);
				journal.archivePoisoned();
				journal = null;
			} else if (journal.isPoisoned) {
				throw new ReplicateError(
					"Replication journal is poisoned; recovery requires --recreate-target so the run-created project can be dropped and rebuilt.",
				);
			} else if (journal.isComplete) {
				const probe = journal.probeEntry?.probe;
				if (!probe) throw new ReplicateError("Completed journal is missing its probe entry");
				const gate = decideGate({
					snapshot,
					probe,
					flags: options.flags,
					destName,
					resume: { journalOwnsProject: journal.projectCreated?.projectId ?? null },
					destIdentifier,
				});
				return resultFromJournal(journal, gate.mode, false, gate.manifests, probe, 0);
			}
		}

		let probe = journal?.probeEntry?.probe;
		if (!probe) {
			const readOnly = await probeTargetReadOnly(client, destIdentifier, destName);
			progress("Running empirical target capability probe in a temporary project...");
			probe = await probeTargetEmpirical(client, readOnly, snapshotNeeds(snapshot), {
				warn: progress,
			});
			journal?.append({ type: "probe", probe });
		}

		// A pending project-create INTENT makes an identifier-holding project
		// tentatively ours for gate purposes (the ambiguous-commit window); the
		// shell phase fingerprint-verifies before actually adopting it.
		const journalOwnsProject =
			journal?.projectCreated?.projectId ??
			(journal?.projectIntent ? (probe.existingProjectId ?? null) : null);
		const gate = decideGate({
			snapshot,
			probe,
			flags: options.flags,
			resume: { journalOwnsProject },
			destIdentifier,
		});
		progress(formatGateProgress(gate.errors, gate.warnings, snapshot, false));
		// On a FRESH run the journal must not exist yet when the gate fails: a
		// gate-failed run that left a journal pinning identifierMode would block
		// its own suggested rerun flags with a resume-mode mismatch.
		if (!gate.ok) throw new ReplicateError(gate.errors.join("\n"));
		if (!journal) {
			journal = Journal.create(
				options.journalPath,
				makeHeader(client, snapshot, options, destName, destIdentifier, initialMode),
				{ warn: progress },
			);
			journal.append({ type: "probe", probe });
		}

		// Every destination write from here on is lock-ownership-guarded: the
		// journal exists, so a stolen lock must stop Plane mutation immediately,
		// not merely the next journal append.
		const write = ownershipGuardedClient(client, journal);

		let projectId = journal.projectCreated?.projectId ?? null;
		if (projectId) {
			await verifyOwnedProject(write, journal, projectId);
		}

		if (journal.cleanupStarted) {
			assertCleanupCanContinue(journal, snapshot, gate.mode);
			if (!projectId)
				throw new ReplicateError("Cleanup-started journal has no run-created project");
			await cleanupPlaceholders(write, journal, projectId, gate.mode);
			await lightVerify(write, snapshot, projectId, gate.mode, journal);
			journal.append({ type: "apply-complete" });
			return resultFromJournal(journal, gate.mode, false, gate.manifests, probe, 0);
		}

		if (!projectId) {
			projectId = await createOrAdoptProject(write, journal, destName, destIdentifier, snapshot);
		}

		const stateMap = await replicateStates(write, journal, projectId, snapshot, gate.manifests);
		const labelMap = await replicateLabels(write, journal, projectId, snapshot);
		const itemPhase = await replicateItems(
			write,
			journal,
			projectId,
			snapshot,
			probe,
			gate.mode,
			stateMap,
			labelMap,
			options,
		);
		if (itemPhase.limited) {
			return resultFromJournal(journal, gate.mode, false, gate.manifests, probe, itemPhase.skipped);
		}

		await replicateParents(write, journal, projectId, snapshot);
		await replicateRelations(write, journal, projectId, snapshot, probe);
		await replicateComments(write, journal, projectId, snapshot, probe, options.sleep);
		await cleanupPlaceholders(write, journal, projectId, gate.mode);
		await lightVerify(write, snapshot, projectId, gate.mode, journal);
		journal.append({ type: "apply-complete" });
		return resultFromJournal(journal, gate.mode, false, gate.manifests, probe, itemPhase.skipped);
	} finally {
		journal?.close();
	}
}

function makeHeader(
	client: ApplyClient,
	snapshot: ProjectSnapshot,
	options: ApplyOptions,
	destName: string,
	destIdentifier: string,
	mode: IdentifierMode,
): JournalHeader {
	return {
		type: "header",
		runId: options.runId ?? randomUUID(),
		createdAt: new Date().toISOString(),
		toolVersion: options.toolVersion,
		snapshotDigest: snapshot.digest,
		target: { baseUrl: client.baseUrl, workspaceSlug: client.workspaceSlug },
		destName,
		destIdentifier,
		identifierMode: mode,
	};
}

function validateResumeOptions(
	journal: Journal,
	destName: string,
	destIdentifier: string,
	mode: IdentifierMode,
): void {
	if (journal.header.destIdentifier !== destIdentifier) {
		throw new ReplicateError(
			`Resume destination identifier mismatch: journal has ${journal.header.destIdentifier}, options request ${destIdentifier}`,
		);
	}
	if (journal.header.destName !== destName) {
		throw new ReplicateError(
			`Resume destination name mismatch: journal has ${journal.header.destName}, options request ${destName}`,
		);
	}
	if (journal.header.identifierMode !== mode) {
		throw new ReplicateError(
			`Resume identifier mode mismatch: journal has ${journal.header.identifierMode}, options request ${mode}`,
		);
	}
}

/**
 * Create the destination project with the same ambiguity discipline as item
 * creates: journal an INTENT first; on resume with a pending intent, an
 * identifier-holding project is adopted only when it fingerprints as ours —
 * our exact name AND zero items (we can only have crashed before any item
 * create, because project-created is journaled before the item phase).
 */
async function createOrAdoptProject(
	client: ApplyClient,
	journal: Journal,
	destName: string,
	destIdentifier: string,
	snapshot: ProjectSnapshot,
): Promise<string> {
	if (journal.projectIntent) {
		const existing = (await client.listProjects<RawProject>()).find(
			(project) => project.identifier?.toLowerCase() === destIdentifier.toLowerCase(),
		);
		if (existing) {
			const items = await client.listWorkItems<RawItem>(existing.id);
			// The emptiness proof must include the ARCHIVED inventory: a foreign
			// same-name project can look empty on the live list while holding
			// archived history that adoption would mutate and --recreate-target
			// would later delete. An unavailable archived endpoint cannot prove
			// emptiness — fail closed (the operator removes the orphan manually).
			const archived = await client.listArchivedWorkItems<RawItem>(existing.id);
			const provablyEmpty = items.length === 0 && archived !== null && archived.length === 0;
			if (existing.name === destName && provablyEmpty) {
				journal.append({
					type: "project-created",
					projectId: existing.id,
					identifier: destIdentifier,
					name: destName,
				});
				return existing.id;
			}
			throw new ReplicateError(
				`Project ${existing.id} holds identifier ${destIdentifier} but does not fingerprint as ` +
					`this run's ambiguous create (name ${JSON.stringify(existing.name ?? "")} vs ` +
					`${JSON.stringify(destName)}, ${items.length} live item(s), ` +
					`${archived === null ? "archived inventory unavailable" : `${archived.length} archived item(s)`}). ` +
					"Refusing to adopt it — remove it manually or pick a different --dest-identifier.",
			);
		}
	} else {
		journal.append({ type: "project-intent", identifier: destIdentifier, name: destName });
	}
	const project = await client.createProject<RawProject>(
		{
			name: destName,
			identifier: destIdentifier,
			description: snapshot.project.description,
		},
		// Retries off: a blind replay of an ambiguous create would 409 on the
		// identifier; the intent + adoption path above is the recovery story.
		{ maxRetries: 0 },
	);
	journal.append({
		type: "project-created",
		projectId: project.id,
		identifier: destIdentifier,
		name: destName,
	});
	return project.id;
}

/**
 * Wrap every PLANE WRITE with a journal-lock ownership check. The per-append
 * check alone is too late: state creation, label creation, archive verbs and
 * --recreate-target's project DELETE all reach Plane before their next append,
 * so a process whose lock was stolen could keep mutating the destination.
 * With this wrapper, a lost lock stops the very next write (only a request
 * already in flight can still land — unavoidable without server-side leases).
 * Reads intentionally pass through unguarded.
 */
function ownershipGuardedClient(base: ApplyClient, journal: Journal): ApplyClient {
	const own = (): void => journal.assertOwnership();
	// Prefer the per-ATTEMPT hook when the client supports it: method-level
	// guarding alone cannot see the client's internal retries after backoff.
	const client = base.withBeforeWriteAttempt ? base.withBeforeWriteAttempt(own) : base;
	return {
		baseUrl: client.baseUrl,
		workspaceSlug: client.workspaceSlug,
		dialect: client.dialect,
		maxRetries: client.maxRetries,
		listProjects: <T>() => client.listProjects<T>(),
		listWorkspaceMembers: <T>() => client.listWorkspaceMembers<T>(),
		getProject: <T>(projectId: string) => client.getProject<T>(projectId),
		getWorkItem: <T>(projectId: string, workItemId: string) =>
			client.getWorkItem<T>(projectId, workItemId),
		listWorkItems: <T>(
			projectId: string,
			query?: Record<string, string | number | boolean | undefined>,
		) => client.listWorkItems<T>(projectId, query),
		listArchivedWorkItems: <T>(projectId: string) => client.listArchivedWorkItems<T>(projectId),
		listStates: <T>(projectId: string) => client.listStates<T>(projectId),
		listLabels: <T>(projectId: string) => client.listLabels<T>(projectId),
		getRelations: (projectId: string, workItemId: string) =>
			client.getRelations(projectId, workItemId),
		listWorkItemComments: <T>(projectId: string, workItemId: string) =>
			client.listWorkItemComments<T>(projectId, workItemId),
		createProject: <T>(body: Record<string, unknown>, opts?: { maxRetries?: number }) => {
			own();
			return client.createProject<T>(body, opts);
		},
		deleteProject: (projectId: string) => {
			own();
			return client.deleteProject(projectId);
		},
		createWorkItem: <T>(
			projectId: string,
			body: Record<string, unknown>,
			opts?: { maxRetries?: number },
		) => {
			own();
			return client.createWorkItem<T>(projectId, body, opts);
		},
		updateWorkItem: <T>(projectId: string, workItemId: string, body: Record<string, unknown>) => {
			own();
			return client.updateWorkItem<T>(projectId, workItemId, body);
		},
		deleteWorkItem: (projectId: string, workItemId: string) => {
			own();
			return client.deleteWorkItem(projectId, workItemId);
		},
		archiveWorkItem: (projectId: string, workItemId: string) => {
			own();
			return client.archiveWorkItem(projectId, workItemId);
		},
		createState: <T>(projectId: string, body: Record<string, unknown>) => {
			own();
			return client.createState<T>(projectId, body);
		},
		updateState: <T>(projectId: string, stateId: string, body: Record<string, unknown>) => {
			own();
			return client.updateState<T>(projectId, stateId, body);
		},
		createLabel: <T>(projectId: string, body: Record<string, unknown>) => {
			own();
			return client.createLabel<T>(projectId, body);
		},
		updateLabel: <T>(projectId: string, labelId: string, body: Record<string, unknown>) => {
			own();
			return client.updateLabel<T>(projectId, labelId, body);
		},
		createRelation: (
			projectId: string,
			workItemId: string,
			relationType: PlaneRelationKind,
			issues: string[],
		) => {
			own();
			return client.createRelation(projectId, workItemId, relationType, issues);
		},
		createWorkItemComment: <T>(
			projectId: string,
			workItemId: string,
			body: Record<string, unknown>,
			opts?: { maxRetries?: number },
		) => {
			own();
			return client.createWorkItemComment<T>(projectId, workItemId, body, opts);
		},
	};
}

async function recreateOwnedTarget(client: ApplyClient, journal: Journal): Promise<void> {
	const owned = journal.projectCreated;
	if (!owned) return;
	let project: RawProject;
	try {
		project = await client.getProject<RawProject>(owned.projectId);
	} catch (error) {
		// Already gone (e.g. poisoned because the project vanished): nothing to
		// delete — recreation proceeds on a fresh journal.
		if (isNotFound(error)) return;
		throw new ReplicateError(
			`Refusing --recreate-target: journal-owned project ${owned.projectId} could not be verified (${describeError(error)}).`,
		);
	}
	if (project.identifier !== owned.identifier) {
		throw new ReplicateError(
			`Refusing --recreate-target: project ${owned.projectId} identifier is ${String(project.identifier)}, not journaled ${owned.identifier}.`,
		);
	}
	await client.deleteProject(owned.projectId);
}

async function verifyOwnedProject(client: ApplyClient, journal: Journal, projectId: string) {
	const owned = journal.projectCreated;
	if (!owned) throw new ReplicateError("Journal project ownership entry is missing");
	let project: RawProject;
	try {
		project = await client.getProject<RawProject>(projectId);
	} catch (error) {
		if (isNotFound(error)) {
			const reason = `Journal-owned project ${projectId} no longer exists`;
			journal.append({ type: "poisoned", reason });
			throw new ReplicateError(`${reason}; recover with --recreate-target after investigation.`);
		}
		// Transient/unknown failure: durable state is unknown — surface it so the
		// operator can simply retry. Poisoning here would demand the destructive
		// --recreate-target recovery over what may be a network blip.
		throw error;
	}
	if (project.identifier !== owned.identifier) {
		const reason = `Journal-owned project fingerprint mismatch for ${projectId}`;
		journal.append({ type: "poisoned", reason });
		throw new ReplicateError(`${reason}; recover with --recreate-target after investigation.`);
	}
}

async function replicateStates(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
	manifests: ApplyManifests,
): Promise<Map<string, string>> {
	const stateMap = mappedStates(journal.entries);
	const targetStates = await client.listStates<RawState>(projectId);
	for (const source of snapshot.states) {
		if (stateMap.has(source.id)) continue;
		const match = targetStates.find(
			(target) =>
				target.name?.toLowerCase() === source.name.toLowerCase() && target.group === source.group,
		);
		let target: RawState;
		let action: "matched" | "created" | "patched";
		if (match) {
			target = match;
			const patch: Record<string, unknown> = {};
			if (match.color !== source.color) patch.color = source.color;
			if ((match.description ?? "") !== source.description) patch.description = source.description;
			if (Object.keys(patch).length > 0) {
				target = await client.updateState<RawState>(projectId, match.id, patch);
				action = "patched";
			} else action = "matched";
		} else {
			target = await client.createState<RawState>(projectId, {
				name: source.name,
				group: source.group,
				color: source.color,
				description: source.description,
			});
			targetStates.push(target);
			action = "created";
		}
		stateMap.set(source.id, target.id);
		journal.append({
			type: "state-mapped",
			sourceStateId: source.id,
			targetStateId: target.id,
			action,
		});
	}
	// Re-assert the default state EVERY run (idempotent): tying it to the
	// per-state create would skip it forever if a crash landed between the
	// state-mapped journal line and the default update.
	const sourceDefault = snapshot.states.find((state) => state.isDefault);
	const defaultTargetId = sourceDefault ? stateMap.get(sourceDefault.id) : undefined;
	if (sourceDefault && defaultTargetId) {
		try {
			await client.updateState(projectId, defaultTargetId, { default: true });
		} catch (error) {
			manifests.warnings.push(
				`Could not make state ${sourceDefault.name} the default: ${describeError(error)}`,
			);
		}
	}
	const mappedTargetIds = new Set(stateMap.values());
	const extras = targetStates.filter((state) => state.default && !mappedTargetIds.has(state.id));
	if (extras.length > 0) {
		manifests.degradations.push({
			feature: "extra target default states",
			detail: `Left target-created default states in place: ${extras.map((state) => state.name).join(", ")}`,
			count: extras.length,
		});
	}
	return stateMap;
}

async function replicateLabels(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
): Promise<Map<string, string>> {
	const labelMap = mappedLabels(journal.entries);
	// Adopt-by-name before creating: a crash between a label POST and its
	// journal line would otherwise re-create the label on resume (duplicate or
	// uniqueness conflict). Label names are unique per project, and the project
	// is run-created, so a name match is ours.
	const existingLabels = await client.listLabels<RawLabel>(projectId);
	const byName = new Map(existingLabels.map((label) => [label.name ?? "", label]));
	for (const source of [...snapshot.labels].sort((a, b) => a.name.localeCompare(b.name))) {
		if (labelMap.has(source.id)) continue;
		const adopted = byName.get(source.name);
		const target =
			adopted ??
			(await client.createLabel<RawLabel>(projectId, {
				name: source.name,
				color: source.color,
				description: source.description,
			}));
		labelMap.set(source.id, target.id);
		journal.append({
			type: "label-mapped",
			sourceLabelId: source.id,
			targetLabelId: target.id,
			action: adopted ? "adopted" : "created",
		});
	}
	for (const source of snapshot.labels) {
		if (!source.parentId) continue;
		const targetId = labelMap.get(source.id);
		const parentId = labelMap.get(source.parentId);
		if (!targetId || !parentId) {
			throw new ReplicateError(`Label parent mapping is incomplete for ${source.name}`);
		}
		await client.updateLabel(projectId, targetId, { parent: parentId });
	}
	return labelMap;
}

async function replicateItems(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	mode: IdentifierMode,
	stateMap: Map<string, string>,
	labelMap: Map<string, string>,
	options: ApplyOptions,
): Promise<{ limited: boolean; skipped: number }> {
	const bySequence = new Map(snapshot.items.map((item) => [item.sequenceId, item]));
	let createCalls = 0;
	let skipped = 0;
	for (let seq = 1; seq <= snapshot.sequence.max; seq++) {
		const source = bySequence.get(seq) ?? null;
		if (!source && mode === "renumber") continue;
		let created = journal.createdBySeq.get(seq);
		const body = source
			? buildItemBody(source, snapshot, probe, stateMap, labelMap)
			: { name: placeholderName(journal.header.runId, seq) };
		const expectedSequence =
			mode === "exact"
				? seq
				: [...journal.createdBySeq.values()].filter((entry) => entry.sourceItemId !== null).length +
					1;
		const expected: ExpectedIdentity = {
			sequence: expectedSequence,
			name: String(body.name),
			externalId: source?.externalId,
			externalSource: source?.externalSource,
		};
		if (!created) {
			const intent = journal.pendingIntent(seq);
			if (intent) {
				const adopted = await reconcileExpectedItem(client, projectId, expected);
				if (adopted) {
					journal.append({
						type: "item-created",
						seq,
						sourceItemId: source?.id ?? null,
						targetItemId: adopted.id,
					});
					created = { targetItemId: adopted.id, sourceItemId: source?.id ?? null };
				}
			}
			if (!created) {
				if (options.limit !== undefined && options.limit >= 0 && createCalls >= options.limit) {
					return { limited: true, skipped };
				}
				if (!intent) journal.append({ type: "item-intent", seq, sourceItemId: source?.id ?? null });
				const result = await createItemA10(client, projectId, body, expected, {
					sleep: options.sleep,
				});
				createCalls++;
				// Poison BEFORE recording the create: if item-created landed first
				// and the process died before the poison line, resume would treat
				// the drifted item as legitimately owning this sequence number.
				if (mode === "exact" && result.sequenceId !== seq) {
					const reason = `Sequence drift at ${seq}: target assigned ${result.sequenceId} (item ${result.id})`;
					journal.append({ type: "poisoned", reason });
					throw new ReplicateError(
						`${reason}. Stop all writers and recover with --recreate-target; patching around drift is unsafe.`,
					);
				}
				journal.append({
					type: "item-created",
					seq,
					sourceItemId: source?.id ?? null,
					targetItemId: result.id,
				});
				created = { targetItemId: result.id, sourceItemId: source?.id ?? null };
			} else {
				skipped++;
			}
		} else {
			skipped++;
		}

		if (source?.archived && probe.archiveVerbAccepted === true) {
			const archived = journal.entries.some(
				(entry) => entry.type === "item-archived" && entry.targetItemId === created?.targetItemId,
			);
			if (!archived) {
				await client.archiveWorkItem(projectId, created.targetItemId);
				journal.append({ type: "item-archived", targetItemId: created.targetItemId });
			}
		}
	}
	return { limited: false, skipped };
}

function buildItemBody(
	item: SnapshotItem,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	stateMap: Map<string, string>,
	labelMap: Map<string, string>,
): Record<string, unknown> {
	const body: Record<string, unknown> = { name: item.name };
	if (item.descriptionHtml !== null) body.description_html = item.descriptionHtml;
	if (item.priority !== null) body.priority = item.priority;
	if (item.point !== null) body.point = item.point;
	if (item.stateId !== null) {
		const state = stateMap.get(item.stateId);
		if (!state)
			throw new ReplicateError(`No target state mapping for source state ${item.stateId}`);
		body.state = state;
	}
	const labels = item.labelIds.map((id) => labelMap.get(id)).filter((id): id is string => !!id);
	if (labels.length > 0) body.labels = labels;
	const assignees = item.assigneeIds
		.map((id) => mappedMemberId(id, snapshot, probe))
		.filter((id): id is string => !!id);
	if (assignees.length > 0) body.assignees = assignees;
	if (item.startDate !== null) body.start_date = item.startDate;
	if (item.targetDate !== null) body.target_date = item.targetDate;
	if (item.externalId !== null) body.external_id = item.externalId;
	if (item.externalSource !== null) body.external_source = item.externalSource;
	if (probe.createdAtAccepted === true && item.createdAt !== null) body.created_at = item.createdAt;
	const creator = mappedMemberId(item.createdBy, snapshot, probe);
	if (probe.createdByAccepted === true && creator) body.created_by = creator;
	return body;
}

async function replicateParents(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
): Promise<void> {
	const bySource = targetBySource(journal);
	for (const item of snapshot.items) {
		if (!item.parentId) continue;
		const target = bySource.get(item.id);
		const parent = bySource.get(item.parentId);
		if (!target || !parent) throw new ReplicateError(`Parent mapping incomplete for ${item.id}`);
		if (journal.parentSet.has(target)) continue;
		await client.updateWorkItem(projectId, target, { parent });
		journal.append({ type: "parent-set", targetItemId: target });
	}
}

async function replicateRelations(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
): Promise<void> {
	const edges = canonicalRelations(snapshot);
	const accepted = new Set(probe.relationKindsAccepted ?? []);
	const targetMap = targetBySource(journal);
	for (const edge of edges) {
		if (!accepted.has(edge.kind)) continue;
		if (journal.relationKeys.has(edge.key)) continue;
		const from = targetMap.get(edge.lowerId);
		const to = targetMap.get(edge.higherId);
		if (!from || !to) continue;
		try {
			await client.createRelation(projectId, from, edge.kind as PlaneRelationKind, [to]);
		} catch (error) {
			if (!isPermanentAlreadyExists(error)) throw error;
		}
		journal.append({ type: "relation-created", key: edge.key });
	}
}

async function replicateComments(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	sleepOverride?: (ms: number) => Promise<void>,
): Promise<void> {
	const targetMap = targetBySource(journal);
	for (const item of snapshot.items) {
		const targetItemId = targetMap.get(item.id);
		if (!targetItemId) continue;
		for (const comment of snapshot.comments[item.id] ?? []) {
			if (journal.commentsCreated.has(comment.id)) continue;
			const built = buildCommentBody(comment, item, snapshot, probe);
			const hasIntent = journal.commentIntents.some(
				(intent) => intent.sourceCommentId === comment.id,
			);
			if (hasIntent) {
				const adopted = await findComment(client, projectId, targetItemId, comment, built);
				if (adopted) {
					journal.append({
						type: "comment-created",
						sourceCommentId: comment.id,
						targetCommentId: adopted.id,
					});
					continue;
				}
			} else {
				journal.append({
					type: "comment-intent",
					sourceCommentId: comment.id,
					sourceItemId: item.id,
				});
			}
			const created = await createCommentA10(
				client,
				projectId,
				targetItemId,
				comment,
				built,
				sleepOverride,
			);
			journal.append({
				type: "comment-created",
				sourceCommentId: comment.id,
				targetCommentId: created.id,
			});
		}
	}
}

interface BuiltComment {
	body: Record<string, unknown>;
	marker: string | null;
	htmlPrefix: string;
	createdAt: string | null;
	/** True when the target preserves our created_at natively — a durable key. */
	createdAtNative: boolean;
}

function buildCommentBody(
	comment: SnapshotComment,
	item: SnapshotItem,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
): BuiltComment {
	const creator = mappedMemberId(comment.createdBy, snapshot, probe);
	const nativeAuthor = probe.commentCreatedByAccepted === true && creator !== null;
	const needsFooter = !nativeAuthor || probe.commentCreatedAtAccepted !== true;
	const marker = needsFooter ? `data-psrepl-comment="${escapeHtml(comment.id)}"` : null;
	let html = comment.commentHtml;
	if (needsFooter) {
		const member = snapshot.members.find((candidate) => candidate.id === comment.createdBy);
		const author = member?.displayName ?? member?.email ?? "unknown";
		const createdAt = comment.createdAt ?? "date unavailable";
		html += `<p ${marker}><em>— replicated from ${escapeHtml(snapshot.project.identifier)}; original author ${escapeHtml(author)}, ${escapeHtml(createdAt)}</em></p>`;
	}
	const body: Record<string, unknown> = { comment_html: html };
	const createdAtNative = probe.commentCreatedAtAccepted === true && comment.createdAt !== null;
	if (createdAtNative) {
		body.created_at = comment.createdAt;
	}
	if (nativeAuthor) body.created_by = creator;
	return {
		body,
		marker,
		htmlPrefix: comment.commentHtml,
		createdAt: comment.createdAt,
		createdAtNative,
	};
}

async function createCommentA10(
	client: ApplyClient,
	projectId: string,
	itemId: string,
	comment: SnapshotComment,
	built: BuiltComment,
	sleepOverride?: (ms: number) => Promise<void>,
): Promise<{ id: string }> {
	const sleep =
		sleepOverride ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = Math.max(1, client.maxRetries + 1);
	for (let attempt = 1; ; attempt++) {
		try {
			return await client.createWorkItemComment<{ id: string }>(projectId, itemId, built.body, {
				maxRetries: 0,
			});
		} catch (error) {
			let found: RawComment | null;
			try {
				found = await findComment(client, projectId, itemId, comment, built);
			} catch (reconcileError) {
				// An ambiguity verdict from reconciliation is a real finding;
				// only reconcile-READ failures fall back to the original error.
				if (reconcileError instanceof ReplicateError) throw reconcileError;
				throw error;
			}
			if (found) return { id: found.id };
			if (!isTransientPlaneError(error) || attempt >= attempts) throw error;
			await sleep(error.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 5000));
		}
	}
}

async function findComment(
	client: ApplyClient,
	projectId: string,
	itemId: string,
	_comment: SnapshotComment,
	built: BuiltComment,
): Promise<RawComment | null> {
	const comments = await client.listWorkItemComments<RawComment>(projectId, itemId);
	if (built.marker) {
		const byMarker = comments.find((comment) => comment.comment_html?.includes(built.marker!));
		if (byMarker) return byMarker;
		// The target may sanitize data-* attributes out of the stored HTML — the
		// marker is then gone even though the write committed. Fall through to
		// created_at when it is a durable (natively preserved) key.
	}
	if (built.createdAtNative) {
		// A natively preserved created_at identifies the comment regardless of
		// how the target rewrote the HTML — but ONLY while it is unique among
		// the item's comments. Nothing enforces per-item timestamp uniqueness in
		// the source, so ambiguity is narrowed by the surviving content prefix
		// and otherwise FAILS CLOSED: guessing could journal the wrong comment
		// as created and silently swallow its sibling.
		const byInstant = comments.filter((comment) =>
			sameNullableInstant(comment.created_at, built.createdAt),
		);
		if (byInstant.length <= 1) return byInstant[0] ?? null;
		const narrowed = byInstant.filter((comment) =>
			(comment.comment_html ?? "").startsWith(built.htmlPrefix),
		);
		if (narrowed.length === 1) return narrowed[0] ?? null;
		throw new ReplicateError(
			`Cannot distinguish the committed comment among ${byInstant.length} comments sharing ` +
				`created_at ${built.createdAt} — refusing to guess. Recover with --recreate-target.`,
		);
	}
	if (built.marker) return null;
	return (
		comments.find(
			(comment) =>
				(comment.comment_html ?? "").startsWith(built.htmlPrefix) &&
				sameNullableInstant(comment.created_at, built.createdAt),
		) ?? null
	);
}

async function cleanupPlaceholders(
	client: ApplyClient,
	journal: Journal,
	projectId: string,
	mode: IdentifierMode,
): Promise<void> {
	if (mode !== "exact") return;
	if (!journal.cleanupStarted) journal.append({ type: "cleanup-started" });
	const deleted = new Set(
		journal.entries
			.filter((entry) => entry.type === "placeholder-deleted")
			.map((entry) => entry.targetItemId),
	);
	for (const placeholder of journal.placeholders()) {
		if (deleted.has(placeholder.targetItemId)) continue;
		try {
			await client.deleteWorkItem(projectId, placeholder.targetItemId);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		journal.append({
			type: "placeholder-deleted",
			targetItemId: placeholder.targetItemId,
			seq: placeholder.seq,
		});
	}
}

function assertCleanupCanContinue(
	journal: Journal,
	snapshot: ProjectSnapshot,
	mode: IdentifierMode,
): void {
	const created = journal.createdBySeq;
	const missing = snapshot.items.filter((item) => !created.has(item.sequenceId));
	if (mode === "exact") {
		for (const gap of snapshot.sequence.gaps) {
			if (!created.has(gap)) {
				throw new ReplicateError(
					`Cleanup already started but sequence ${gap} was never created; item creation can never resume for this journal. Recover with --recreate-target.`,
				);
			}
		}
	}
	if (missing.length > 0) {
		throw new ReplicateError(
			`Cleanup already started but ${missing.length} source item(s) are missing; item creation can never resume for this journal. Recover with --recreate-target.`,
		);
	}
}

async function lightVerify(
	client: ApplyClient,
	snapshot: ProjectSnapshot,
	projectId: string,
	mode: IdentifierMode,
	journal: Journal,
): Promise<void> {
	const live = await client.listWorkItems<RawItem>(projectId);
	const archivedInventory = await client.listArchivedWorkItems<RawItem>(projectId);
	const archived: RawItem[] = archivedInventory ?? [];
	if (archivedInventory === null) {
		const liveIds = new Set(live.map((item) => item.id));
		const targetMap = targetBySource(journal);
		for (const source of snapshot.items.filter((item) => item.archived)) {
			const targetId = targetMap.get(source.id);
			if (!targetId || liveIds.has(targetId)) continue;
			archived.push(await client.getWorkItem<RawItem>(projectId, targetId));
		}
	}
	const items = [...new Map([...live, ...archived].map((item) => [item.id, item])).values()];
	if (items.length !== snapshot.items.length) {
		throw new ReplicateError(
			`Light verification failed: target has ${items.length} items, expected ${snapshot.items.length}`,
		);
	}
	// Identity containment in BOTH modes: a count can match while a replicated
	// item was deleted and a foreign one appeared. Every journal-owned real
	// item must still exist on the target.
	const liveIds = new Set(items.map((item) => item.id));
	const ownedIds = [...journal.createdBySeq.values()]
		.filter((entry) => entry.sourceItemId !== null)
		.map((entry) => entry.targetItemId);
	const missingOwned = ownedIds.filter((id) => !liveIds.has(id));
	if (missingOwned.length > 0) {
		throw new ReplicateError(
			`Light verification failed: ${missingOwned.length} replicated item(s) no longer exist on the target (first: ${missingOwned[0]})`,
		);
	}
	if (mode === "exact") {
		const actual = items.map((item) => item.sequence_id).sort((a, b) => a - b);
		const expected = snapshot.items.map((item) => item.sequenceId);
		if (actual.length !== expected.length || actual.some((seq, index) => seq !== expected[index])) {
			throw new ReplicateError(
				`Light verification failed: target sequence set [${actual.join(",")}] does not equal source [${expected.join(",")}]`,
			);
		}
	}
	// Archived membership when the inventory endpoint serves: everything the
	// JOURNAL says was archived must actually be archived. (Keyed off the
	// journal, not the snapshot — when the archive verb is unaccepted, archived
	// sources legitimately land unarchived as a gate-recorded degradation.)
	if (archivedInventory !== null) {
		const archivedIds = new Set(archivedInventory.map((item) => item.id));
		for (const entry of journal.entries) {
			if (entry.type === "item-archived" && !archivedIds.has(entry.targetItemId)) {
				throw new ReplicateError(
					`Light verification failed: item ${entry.targetItemId} was archived by this run but is not archived on the target`,
				);
			}
		}
	}
}

function resultFromJournal(
	journal: Journal,
	mode: IdentifierMode,
	dryRun: boolean,
	manifests: ApplyManifests,
	probe: TargetProbeResult,
	itemsSkipped: number,
): ApplyResult {
	const entries = journal.entries;
	const itemCreated = entries.filter((entry) => entry.type === "item-created");
	return {
		mode,
		dryRun,
		projectId: journal.projectCreated?.projectId ?? null,
		itemsCreated: itemCreated.filter((entry) => entry.sourceItemId !== null).length,
		itemsSkipped,
		placeholdersCreated: itemCreated.filter((entry) => entry.sourceItemId === null).length,
		placeholdersDeleted: entries.filter((entry) => entry.type === "placeholder-deleted").length,
		parentsSet: entries.filter((entry) => entry.type === "parent-set").length,
		relationsCreated: entries.filter((entry) => entry.type === "relation-created").length,
		commentsCreated: entries.filter((entry) => entry.type === "comment-created").length,
		archivedCount: entries.filter((entry) => entry.type === "item-archived").length,
		manifests,
		complete: journal.isComplete,
		probe,
	};
}

function emptyResult(
	mode: IdentifierMode,
	dryRun: boolean,
	projectId: string | null,
	manifests: ApplyManifests,
	probe: TargetProbeResult,
): ApplyResult {
	return {
		mode,
		dryRun,
		projectId,
		itemsCreated: 0,
		itemsSkipped: 0,
		placeholdersCreated: 0,
		placeholdersDeleted: 0,
		parentsSet: 0,
		relationsCreated: 0,
		commentsCreated: 0,
		archivedCount: 0,
		manifests,
		complete: false,
		probe,
	};
}

function mappedStates(entries: readonly JournalEntry[]): Map<string, string> {
	return new Map(
		entries
			.filter((entry) => entry.type === "state-mapped")
			.map((entry) => [entry.sourceStateId, entry.targetStateId]),
	);
}

function mappedLabels(entries: readonly JournalEntry[]): Map<string, string> {
	return new Map(
		entries
			.filter((entry) => entry.type === "label-mapped")
			.map((entry) => [entry.sourceLabelId, entry.targetLabelId]),
	);
}

function targetBySource(journal: Journal): Map<string, string> {
	const out = new Map<string, string>();
	for (const entry of journal.createdBySeq.values()) {
		if (entry.sourceItemId) out.set(entry.sourceItemId, entry.targetItemId);
	}
	return out;
}

function mappedMemberId(
	sourceId: string | null,
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
): string | null {
	if (!sourceId) return null;
	const email = snapshot.members.find((member) => member.id === sourceId)?.email;
	return email ? (probe.memberByEmail[email.toLowerCase()] ?? null) : null;
}

function placeholderName(runId: string, seq: number): string {
	return `planestories:placeholder:${runId}:${seq}`;
}

function snapshotNeeds(snapshot: ProjectSnapshot) {
	const relationKinds = new Set<string>();
	for (const relations of Object.values(snapshot.relations)) {
		for (const kind of Object.keys(relations)) relationKinds.add(kind);
	}
	return {
		relationKinds: [...relationKinds].sort(),
		archived: snapshot.items.some((item) => item.archived),
		anyComments: Object.values(snapshot.comments).some((comments) => comments.length > 0),
	};
}

export function canonicalRelations(snapshot: ProjectSnapshot): Array<{
	key: string;
	kind: string;
	lowerId: string;
	higherId: string;
}> {
	const sequence = new Map(snapshot.items.map((item) => [item.id, item.sequenceId]));
	const out = new Map<string, { key: string; kind: string; lowerId: string; higherId: string }>();
	for (const [fromId, relations] of Object.entries(snapshot.relations)) {
		const fromSeq = sequence.get(fromId);
		if (fromSeq === undefined) continue;
		for (const [rawKind, ids] of Object.entries(relations)) {
			for (const toId of ids) {
				const toSeq = sequence.get(toId);
				if (toSeq === undefined || toSeq === fromSeq) continue;
				const fromIsLower = fromSeq < toSeq;
				const lowerId = fromIsLower ? fromId : toId;
				const higherId = fromIsLower ? toId : fromId;
				const kind = fromIsLower ? rawKind : inverseRelation(rawKind);
				const key = `${kind}:${lowerId}:${higherId}`;
				out.set(key, { key, kind, lowerId, higherId });
			}
		}
	}
	return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function inverseRelation(kind: string): string {
	const inverse: Record<string, string> = {
		blocked_by: "blocking",
		blocking: "blocked_by",
		start_before: "start_after",
		start_after: "start_before",
		finish_before: "finish_after",
		finish_after: "finish_before",
		relates_to: "relates_to",
		duplicate: "duplicate",
	};
	return inverse[kind] ?? kind;
}

function isPermanentAlreadyExists(error: unknown): boolean {
	return (
		error instanceof PlaneApiError &&
		error.status !== undefined &&
		error.status >= 400 &&
		error.status < 500 &&
		/already|exist|duplicate/i.test(error.message)
	);
}

function isNotFound(error: unknown): boolean {
	return error instanceof PlaneApiError && error.status === 404;
}

function sameNullableInstant(actual: string | null | undefined, expected: string | null): boolean {
	if (actual == null || expected == null) return actual == null && expected == null;
	return Date.parse(actual) === Date.parse(expected);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function formatGateProgress(
	errors: string[],
	warnings: string[],
	snapshot: ProjectSnapshot,
	dryRun: boolean,
): string {
	const prefix = dryRun ? "Dry-run plan" : "Pre-write gate";
	return [
		`${prefix}: ${snapshot.items.length} real items, ${snapshot.sequence.gaps.length} gaps, ${Object.values(snapshot.comments).flat().length} comments.`,
		...warnings.map((warning) => `WARNING: ${warning}`),
		...errors.map((error) => `ERROR: ${error}`),
	].join("\n");
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
