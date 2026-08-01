import { ConfigError } from "../errors.ts";
import { spliceAcceptanceCriteria } from "../markdown/criteria.ts";
import type { PlaneClient } from "../plane/client.ts";
import {
	ensureComment,
	type FetchedWorkItem,
	fetchProjectIndex,
	type ProjectIndex,
	updateWorkItem,
} from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { criterionIndex, descriptionHasCriteria, isCriterionChild } from "./board-story.ts";
import { EXTERNAL_SOURCE } from "./importer.ts";
import { reverseSyncCriteria, type WriteBackReport } from "./writeback.ts";

/** Marker embedded in the migration close-comment so re-runs don't post duplicates. */
export const MIGRATE_CLOSE_MARKER = "[planestories:criteria-migrated-to-description]";

/** State groups that count as "closed" — an open child is anything else. */
const CLOSED_GROUPS = new Set(["completed", "cancelled"]);

export interface MigrateOptions {
	config: ResolvedConfig;
	project?: string;
	/** Story files to reconcile (checkbox state board→file) BEFORE closing children. */
	files?: string[];
	/** Apply changes. Without this, migrate is a read-only report (dry-run). */
	apply?: boolean;
	/** Max parents to migrate per run (rate-limit batching). 0/undefined = all. */
	limit?: number;
}

export interface MigrateParentRef {
	identifier: string;
	title: string;
	criteria: number;
	openChildren: number;
}

export interface MigrateReport {
	project: string;
	/** Parents whose `::ac<n>` children were folded into the description this run. */
	migrated: MigrateParentRef[];
	/** Parents already carrying a description checklist — only leftover children closed. */
	alreadyMigrated: MigrateParentRef[];
	/** Parents skipped because of a conflict (e.g. duplicate `::ac<n>` index). */
	conflicts: Array<{ identifier: string; title: string; reason: string }>;
	/** Total criterion children folded into a description. */
	criteriaFolded: number;
	/** Total open criterion children moved to a completed state. */
	childrenClosed: number;
	/** Parents deferred past the --limit this run. */
	deferred: number;
	/** File reconciliation (checkbox state board→file), if --files was given. */
	fileReport?: WriteBackReport;
	applied: boolean;
}

/** The planestories-owned criterion children of a parent, by `::ac<n>` index. */
function criterionChildrenOf(index: ProjectIndex, parentId: string): FetchedWorkItem[] {
	return (index.childrenByParent.get(parentId) ?? [])
		.filter((c) => isCriterionChild(c) && c.externalSource === EXTERNAL_SOURCE)
		.sort((a, b) => criterionIndex(a) - criterionIndex(b));
}

export interface CriteriaDriftRef {
	identifier: string;
	title: string;
	openChildren: number;
}

export interface CriteriaMigrationDrift {
	/** Parents with `::ac<n>` children but NO description checklist — need migration. */
	unmigrated: CriteriaDriftRef[];
	/** Parents that have a description checklist AND still-open `::ac<n>` children —
	 * a half-migrated / dual-representation state needing a `migrate-criteria` cleanup. */
	dual: CriteriaDriftRef[];
}

/**
 * Read-only detection (for `doctor`) of criteria-representation drift, using the
 * §2 precedence fence: a parent is "migrated" iff its description has a task-list.
 * Flags BOTH the unmigrated case (children but no checklist) AND the dual case
 * (checklist plus leftover open children) — the latter is missed by a
 * "children-but-no-checklist" check alone (Codex #9).
 */
export function checkCriteriaMigration(
	index: ProjectIndex,
	projectIdentifier: string,
): CriteriaMigrationDrift {
	const unmigrated: CriteriaDriftRef[] = [];
	const dual: CriteriaDriftRef[] = [];
	for (const item of index.items) {
		if (isCriterionChild(item)) {
			continue;
		}
		const children = criterionChildrenOf(index, item.id);
		if (children.length === 0) {
			continue;
		}
		const openChildren = children.filter(
			(c) => !c.stateGroup || !CLOSED_GROUPS.has(c.stateGroup),
		).length;
		const ref: CriteriaDriftRef = {
			identifier: `${projectIdentifier}-${item.sequenceId}`,
			title: item.name,
			openChildren,
		};
		if (descriptionHasCriteria(item)) {
			if (openChildren > 0) {
				dual.push(ref);
			}
		} else {
			unmigrated.push(ref);
		}
	}
	return { unmigrated, dual };
}

/**
 * Fold legacy `::ac<n>` criterion sub-items into their parent's description as a
 * TipTap task-list, then close the now-redundant children — collapsing the board
 * from "one work item per criterion" to "criteria as checkboxes in the parent".
 *
 * Ordering is clobber-safe (design §4.6): FILE reconciliation first (via the
 * existing board→file reverse-sync, so linked story files carry the children's
 * current checked state and a later import cannot revert it), THEN the board
 * description, THEN close the children. A crash between steps leaves a re-runnable
 * state — the "already migrated" test is "the description already has a task-list"
 * (NOT "no children", since children are closed but never deleted), so a second
 * run is a no-op.
 *
 * Idempotent, dry-run by default. Conflicts (a duplicate `::ac<n>` index from a
 * stale rename) are reported and skipped, never guessed.
 */
export async function migrateCriteria(
	client: PlaneClient,
	options: MigrateOptions,
): Promise<MigrateReport> {
	const resolver = new Resolver(client);
	const projectName = options.project ?? options.config.defaultProject ?? undefined;
	if (!projectName) {
		throw new ConfigError(
			"No project specified for migrate-criteria. Provide --project or set defaultProject in config.",
		);
	}
	const project = await resolver.resolveProject(projectName);

	// STEP 1 (clobber-safe): reconcile linked story files with the children's board
	// state FIRST, so the file — which a later import treats as authoritative — carries
	// the states we're about to fold, and cannot revert them. Read-only in dry-run.
	let fileReport: WriteBackReport | undefined;
	if (options.files && options.files.length > 0) {
		fileReport = await reverseSyncCriteria(client, {
			config: options.config,
			files: options.files,
			project: options.project,
			apply: options.apply,
		});
	}

	const index = await fetchProjectIndex(client, project.id, project.identifier);
	const ident = (item: FetchedWorkItem): string => `${project.identifier}-${item.sequenceId}`;
	const isOpen = (item: FetchedWorkItem): boolean =>
		!item.stateGroup || !CLOSED_GROUPS.has(item.stateGroup);

	// Candidate parents: any item that has planestories `::ac<n>` children (a parent
	// is never itself a criterion child). Deterministic order for stable --limit batching.
	const parents = index.items
		.filter((item) => !isCriterionChild(item) && criterionChildrenOf(index, item.id).length > 0)
		.sort((a, b) => a.sequenceId - b.sequenceId);

	const limit = options.limit && options.limit > 0 ? options.limit : parents.length;
	const selected = parents.slice(0, limit);
	const deferred = parents.length - selected.length;

	const migrated: MigrateParentRef[] = [];
	const alreadyMigrated: MigrateParentRef[] = [];
	const conflicts: Array<{ identifier: string; title: string; reason: string }> = [];
	let criteriaFolded = 0;
	let childrenClosed = 0;

	const completedStateId =
		options.apply && selected.length > 0
			? await resolver.firstStateIdInGroups(project.id, ["completed"])
			: null;
	if (options.apply && selected.length > 0 && !completedStateId) {
		throw new ConfigError(
			`No completed-group state found in project ${project.identifier} to close sub-items into.`,
		);
	}

	const closeChildren = async (openChildren: FetchedWorkItem[]): Promise<void> => {
		if (!options.apply || !completedStateId) {
			return;
		}
		for (const child of openChildren) {
			await updateWorkItem(client, project.id, child.id, { stateId: completedStateId });
			await ensureComment(
				client,
				project.id,
				child.id,
				MIGRATE_CLOSE_MARKER,
				`<p>Criteria migrated into the parent description by planestories. ${MIGRATE_CLOSE_MARKER}</p>`,
			);
			childrenClosed++;
		}
	};

	for (const parent of selected) {
		const children = criterionChildrenOf(index, parent.id);
		const openChildren = children.filter(isOpen);

		// Already migrated: the description carries the checklist (fold done on a prior
		// run, or authored directly). Just close any leftover open children (dual state).
		if (descriptionHasCriteria(parent)) {
			alreadyMigrated.push({
				identifier: ident(parent),
				title: parent.name,
				criteria: 0,
				openChildren: openChildren.length,
			});
			await closeChildren(openChildren);
			continue;
		}

		// Conflict: two children claim the same `::ac<n>` index (a stale rename) — the
		// same ambiguity writeback fails closed on. Report + skip; never guess a merge.
		const indices = children.map(criterionIndex);
		if (new Set(indices).size !== indices.length) {
			conflicts.push({
				identifier: ident(parent),
				title: parent.name,
				reason: "duplicate ::ac<n> index among children (stale rename?)",
			});
			continue;
		}

		// Derive criteria from ALL children (captured before any close): full child
		// description when the name was truncated at 255 chars, checked = completed.
		const criteria = children.map((child) => ({
			text: (child.description?.trim() || child.name).trim(),
			checked: child.stateGroup === "completed",
		}));
		const newBody = spliceAcceptanceCriteria(parent.description ?? "", criteria);

		if (options.apply) {
			await updateWorkItem(client, project.id, parent.id, { body: newBody });
		}
		criteriaFolded += criteria.length;
		migrated.push({
			identifier: ident(parent),
			title: parent.name,
			criteria: criteria.length,
			openChildren: openChildren.length,
		});
		await closeChildren(openChildren);
	}

	return {
		project: project.identifier,
		migrated,
		alreadyMigrated,
		conflicts,
		criteriaFolded,
		childrenClosed,
		deferred,
		fileReport,
		applied: Boolean(options.apply),
	};
}
