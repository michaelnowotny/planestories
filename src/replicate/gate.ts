import type { TargetProbeResult } from "./probe.ts";
import type { ApplyManifests, DegradationEntry, IdentifierMode, ProjectSnapshot } from "./types.ts";

export interface GateFlags {
	allowSqlFinalize: boolean;
	noExactIdentifiers: boolean;
	assumeGapsDeleted: boolean;
	recreateTarget: boolean;
	/** Proceed even though the destination holds items absent from the snapshot. */
	allowDivergentTarget?: boolean;
}

export interface GateInput {
	snapshot: ProjectSnapshot;
	probe: TargetProbeResult;
	flags: GateFlags;
	resume: { journalOwnsProject: string | null };
	destIdentifier: string;
	/** Destination project name — Plane enforces uniqueness on this separately. */
	destName?: string;
	/**
	 * Sequence ids this run already created on the destination (real items and gap
	 * placeholders). They are OURS, so a destination carrying the residue of an
	 * interrupted run of this same snapshot is not divergence.
	 */
	ownedSequenceIds?: number[];
}

export interface GateDecision {
	ok: boolean;
	mode: IdentifierMode;
	errors: string[];
	warnings: string[];
	manifests: ApplyManifests;
}

/** Pure, fail-closed feasibility decision. It never consults live state itself. */
export function decideGate(input: GateInput): GateDecision {
	const { snapshot, probe, flags } = input;
	const mode: IdentifierMode = flags.noExactIdentifiers ? "renumber" : "exact";
	const errors: string[] = [];
	const warnings: string[] = [];
	const manifests: ApplyManifests = { degradations: [], losses: [], warnings };

	if (probe.existingProjectId && probe.existingProjectId !== input.resume.journalOwnsProject) {
		errors.push(
			`Destination identifier ${input.destIdentifier} is already held by project ${probe.existingProjectId}; the journal does not own it.`,
		);
	}
	// The name is a SEPARATE Plane uniqueness constraint from the identifier: freeing
	// only the identifier leaves the create to fail mid-apply on a raw 409. Fail closed
	// here, where every other precondition is checked, and name the remedy.
	// DIVERGENCE GUARD (the name-uniqueness check is the separate block below).
	// After a cutover the destination is the authoritative board and
	// accumulates work the snapshot never saw; applying a stale snapshot over it destroys
	// that work silently, totally and irreversibly. Ownership is NOT a sufficient proxy:
	// the journal-ownership check is satisfied the moment somebody frees the identifier,
	// which is exactly the ritual a normal cutover teaches. Compare CONTENT.
	if (probe.existingProjectId !== null) {
		const known = new Set([
			...input.snapshot.items.map((item) => item.sequenceId),
			...(input.ownedSequenceIds ?? []),
		]);
		if (probe.targetSequenceIds === undefined) {
			errors.push(
				"Could not enumerate the destination project's existing items, so divergence cannot be ruled out. Refusing rather than assuming the destination is safe to overwrite.",
			);
		} else if (probe.targetSequenceIds !== null) {
			const unknown = probe.targetSequenceIds.filter((sequenceId) => !known.has(sequenceId));
			if (unknown.length === 0 && probe.targetArchivedEnumerable === false) {
				warnings.push(
					"The destination's archived items could not be enumerated on this instance, so divergence among ARCHIVED items cannot be ruled out — only live items were compared.",
				);
			}
			if (unknown.length > 0) {
				const examples = unknown
					.slice(0, 5)
					.map((sequenceId) => `${input.destIdentifier}-${sequenceId}`)
					.join(", ");
				const more = unknown.length > 5 ? `, and ${unknown.length - 5} more` : "";
				const detail = `Destination project ${input.destIdentifier} holds ${unknown.length} item(s) this snapshot has never seen (${examples}${more}).`;
				if (flags.allowDivergentTarget) {
					warnings.push(
						`${detail} Proceeding because --allow-divergent-target was passed; work only on the destination WILL be overwritten.`,
					);
				} else {
					errors.push(
						`${detail} The destination has diverged from this snapshot — applying it would overwrite that work irreversibly. Re-snapshot the destination if it is now authoritative, or pass --allow-divergent-target if you truly mean to overwrite it.`,
					);
				}
			}
		}
	}

	if (probe.nameAvailable === false) {
		errors.push(
			`Destination project name "${input.destName}" is already taken on the target. Free it (rename the holder, e.g. \`rename-project --project <ID> --name "<something else>" --yes\`) or pass --dest-name.`,
		);
	}
	if (!probe.identifierAvailable && probe.existingProjectId === null) {
		errors.push(`Destination identifier ${input.destIdentifier} is unavailable on the target.`);
	}

	if (probe.sequencesMaxEver === false && flags.allowSqlFinalize && !flags.noExactIdentifiers) {
		errors.push("--allow-sql-finalize is not implemented in this build (failing closed)");
	} else if (probe.sequencesMaxEver === false && mode === "exact") {
		errors.push(
			"Target sequence allocation is not max-ever, so exact identifiers are infeasible. " +
				"Re-run with --allow-sql-finalize or --no-exact-identifiers.",
		);
	}

	if (
		snapshot.source.archivedInventory === "unavailable" &&
		snapshot.sequence.gaps.length > 0 &&
		!flags.assumeGapsDeleted
	) {
		errors.push(
			"The source archived inventory was unavailable and sequence gaps may hide archived items; " +
				"re-run with --assume-gaps-deleted only after confirming the gaps are deletions.",
		);
	}

	const longTitles = snapshot.items.filter((item) => item.name.length > 255);
	if (longTitles.length > 0) {
		errors.push(
			`Plane rejects titles over 255 characters; offending source items: ${longTitles
				.map((item) => `${snapshot.project.identifier}-${item.sequenceId}`)
				.join(", ")}`,
		);
	}

	if (probe.sequencesMaxEver === null && mode === "exact") {
		warnings.push(
			"Real apply will empirically verify max-ever sequence allocation before destination writes.",
		);
	}
	if (probe.stateWriteAccepted === false) {
		errors.push("Target rejected state create/update operations required by the snapshot.");
	} else if (probe.stateWriteAccepted === null) {
		warnings.push("Real apply will probe state create/update support.");
	}

	collectMemberDegradations(snapshot, probe, manifests.degradations);
	collectCapabilityDegradations(snapshot, probe, manifests.degradations, warnings);
	collectLosses(snapshot, manifests.losses);

	return { ok: errors.length === 0, mode, errors, warnings, manifests };
}

function collectMemberDegradations(
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	degradations: DegradationEntry[],
): void {
	const members = new Map(snapshot.members.map((member) => [member.id, member]));
	const targetEmails = new Set(
		Object.keys(probe.memberByEmail).map((email) => email.toLowerCase()),
	);
	const nullEmail = snapshot.members.filter((member) => member.email === null).length;
	let missingAuthor = 0;
	let missingAssignee = 0;
	const classify = (memberId: string | null, kind: "author" | "assignee") => {
		if (!memberId) return;
		const member = members.get(memberId);
		if (!member?.email) {
			return;
		}
		if (!targetEmails.has(member.email.toLowerCase())) {
			if (kind === "author") missingAuthor++;
			else missingAssignee++;
		}
	};
	for (const item of snapshot.items) {
		classify(item.createdBy, "author");
		for (const assignee of item.assigneeIds) classify(assignee, "assignee");
		for (const comment of snapshot.comments[item.id] ?? []) classify(comment.createdBy, "author");
	}
	if (nullEmail > 0) {
		degradations.push({
			feature: "members without email",
			detail: "Source member cannot be mapped because the snapshot has no email.",
			count: nullEmail,
		});
	}
	if (missingAuthor > 0) {
		degradations.push({
			feature: "authorship",
			detail: "Source author email is not a member of the target workspace.",
			count: missingAuthor,
		});
	}
	if (missingAssignee > 0) {
		degradations.push({
			feature: "assignees",
			detail: "Source assignee email is not a member of the target workspace.",
			count: missingAssignee,
		});
	}
}

function collectCapabilityDegradations(
	snapshot: ProjectSnapshot,
	probe: TargetProbeResult,
	degradations: DegradationEntry[],
	warnings: string[],
): void {
	const archivedCount = snapshot.items.filter((item) => item.archived).length;
	if (archivedCount > 0 && probe.archiveVerbAccepted === false) {
		degradations.push({
			feature: "archive status",
			detail: "Target archive verb is unavailable; archived items will land unarchived.",
			count: archivedCount,
		});
	} else if (archivedCount > 0 && probe.archiveVerbAccepted === null) {
		warnings.push("Real apply will probe the target archive verb.");
	}

	if (probe.relationKindsAccepted !== null) {
		const accepted = new Set(probe.relationKindsAccepted);
		const rejectedCounts = new Map<string, number>();
		for (const relations of Object.values(snapshot.relations)) {
			for (const [kind, targets] of Object.entries(relations)) {
				if (!accepted.has(kind))
					rejectedCounts.set(kind, (rejectedCounts.get(kind) ?? 0) + targets.length);
			}
		}
		for (const [kind, rawCount] of rejectedCounts) {
			degradations.push({
				feature: `relation ${kind}`,
				detail: `Target rejected relation kind ${kind}; those edges will be skipped.`,
				count: Math.ceil(rawCount / 2),
			});
		}
	} else if (Object.keys(snapshot.relations).length > 0) {
		warnings.push("Real apply will probe only the relation kinds used by this snapshot.");
	}
	const sourceIds = new Set(snapshot.items.map((item) => item.id));
	let crossProject = 0;
	for (const relations of Object.values(snapshot.relations)) {
		for (const targets of Object.values(relations)) {
			crossProject += targets.filter((target) => !sourceIds.has(target)).length;
		}
	}
	if (crossProject > 0) {
		degradations.push({
			feature: "cross-project relations",
			detail: "Relation endpoints outside the snapshot cannot be recreated.",
			count: crossProject,
		});
	}

	const datedItems = snapshot.items.filter((item) => item.createdAt !== null).length;
	if (datedItems > 0 && probe.createdAtAccepted === false) {
		degradations.push({
			feature: "item creation dates",
			detail: "Target does not accept created_at; creation dates will not be preserved.",
			count: datedItems,
		});
	}
	const authoredItems = snapshot.items.filter((item) => item.createdBy !== null).length;
	if (authoredItems > 0 && probe.createdByAccepted === false) {
		degradations.push({
			feature: "item authorship",
			detail: "Target does not accept created_by; item authorship will not be preserved.",
			count: authoredItems,
		});
	}
	const comments = Object.values(snapshot.comments).flat();
	if (
		comments.length > 0 &&
		(probe.commentCreatedAtAccepted === false || probe.commentCreatedByAccepted === false)
	) {
		degradations.push({
			feature: "comment provenance",
			detail: "Comment timestamps/authorship will use the provenance footer fallback.",
			count: comments.length,
		});
	}
	if (probe.createdAtAccepted === null || probe.createdByAccepted === null) {
		warnings.push("Real apply will probe item created_at and created_by fidelity.");
	}
	if (
		comments.length > 0 &&
		(probe.commentCreatedAtAccepted === null || probe.commentCreatedByAccepted === null)
	) {
		warnings.push("Real apply will probe comment created_at and created_by fidelity.");
	}
}

function collectLosses(snapshot: ProjectSnapshot, losses: DegradationEntry[]): void {
	losses.push({
		feature: "cycles/modules/pages",
		detail: "Snapshot schema v1 does not carry cycles, modules, or pages.",
		count: 1,
	});
	losses.push({
		feature: "attachments/reactions",
		detail:
			"Not inventoried in snapshot schema v1 — not carried and not counted per item " +
			"(description-embedded asset URLs still point at the source instance).",
		count: 1,
	});
	// Activity is reported SEPARATELY and by what this snapshot actually holds.
	// The grouped "not inventoried" line above used to cover it, and that wording
	// becomes a lie the moment --with-activity is used: the trail IS carried in
	// the file and IS counted per item, it is simply never replayed. A loss report
	// that understates what it holds is as misleading as one that overstates it.
	if (snapshot.activities === undefined) {
		losses.push({
			feature: "activity/audit log",
			detail:
				"Not captured — re-snapshot with --with-activity to archive the source's audit " +
				"trail before retiring it. Either way it is never replayed onto the target.",
			count: 1,
		});
	} else {
		const entries = Object.values(snapshot.activities).reduce(
			(sum, values) => sum + values.length,
			0,
		);
		losses.push({
			feature: "activity/audit log",
			detail:
				"Captured in this snapshot as archival evidence, but deliberately NOT replayed: " +
				"Plane stamps its own activity as the replica is written, and a forged audit " +
				"trail would be worse than none. The history lives in the snapshot file.",
			count: entries,
		});
	}
	const updated = snapshot.items.filter((item) => item.updatedAt !== null).length;
	if (updated > 0) {
		losses.push({
			feature: "updated_at",
			detail: "Work-item updated_at is never preserved.",
			count: updated,
		});
	}
	const completed = snapshot.items.filter((item) => item.completedAt !== null).length;
	if (completed > 0) {
		losses.push({
			feature: "completed_at",
			detail: "Work-item completed_at is snapshotted but not writable on create.",
			count: completed,
		});
	}
}
