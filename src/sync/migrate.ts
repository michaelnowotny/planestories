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
import {
	criterionIndex,
	descriptionHasCriteria,
	isCriterionChild,
	isOwnedCriterionChild,
} from "./board-story.ts";

/** Marker embedded in the migration close-comment so re-runs don't post duplicates. */
export const MIGRATE_CLOSE_MARKER = "[planestories:criteria-migrated-to-description]";

/** State groups that count as "closed" — an open child is anything else. */
const CLOSED_GROUPS = new Set(["completed", "cancelled"]);

export interface MigrateOptions {
	config: ResolvedConfig;
	project?: string;
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
	applied: boolean;
}

/** The planestories-owned criterion children of a parent, by `::ac<n>` index. */
function criterionChildrenOf(index: ProjectIndex, parentId: string): FetchedWorkItem[] {
	return (index.childrenByParent.get(parentId) ?? [])
		.filter(isOwnedCriterionChild)
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
 * **Board-only.** For each un-migrated parent it folds children→description (a
 * `spliceAcceptanceCriteria` that preserves prefix + suffix; text from the full
 * child.description; checked = child completed-state), THEN closes the open
 * children. It does NOT touch story files — reconciling files is `export`'s job
 * (which, post-branch, reconstructs criteria description-first with the correct
 * count/text/state via the same splice). The safe operator sequence is therefore
 * `migrate-criteria --yes` → `export` (regenerates files from the migrated board)
 * → `import` (a warm no-op). Doing a bespoke file splice inside migrate was
 * rejected: the only reusable primitive (reverseSyncCriteria) merely flips
 * existing checkbox marks by position and cannot reconcile a count/text
 * divergence, so it could leave a stale file that later clobbers the board.
 *
 * Idempotent: the "already migrated" test is "the description AC section already
 * has a checklist" (NOT "no children" — children are closed, never deleted). A
 * fully-migrated parent leaves the candidate window so `--limit` always advances.
 * Dry-run by default. A duplicate `::ac<n>` index (stale rename) is reported and
 * skipped, never guessed.
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

	const index = await fetchProjectIndex(client, project.id, project.identifier);
	const ident = (item: FetchedWorkItem): string => `${project.identifier}-${item.sequenceId}`;
	const isOpen = (item: FetchedWorkItem): boolean =>
		!item.stateGroup || !CLOSED_GROUPS.has(item.stateGroup);

	const hasDuplicateIndex = (children: FetchedWorkItem[]): boolean => {
		const indices = children.map(criterionIndex);
		return new Set(indices).size !== indices.length;
	};

	// Classify parents up front (deterministic order):
	//  - CONFLICT: an un-migrated parent whose children have a duplicate `::ac<n>`
	//    index (a stale rename). Reported EVERY run, but NEVER counted against
	//    `--limit` and NEVER selected — otherwise a permanent conflict at the front
	//    of the window would consume the limit slot forever and starve later valid
	//    parents (Codex #2 / Grok residual).
	//  - WORK: un-migrated non-conflict (fold needed) OR migrated-with-open-children
	//    (dual, close needed). `--limit` applies to these.
	//  - FULLY MIGRATED (checklist + no open children): skipped entirely, so the
	//    window advances across runs (Grok BLOCK 2). Children are closed not deleted.
	const conflicts: Array<{ identifier: string; title: string; reason: string }> = [];
	const workParents: FetchedWorkItem[] = [];
	for (const item of [...index.items].sort((a, b) => a.sequenceId - b.sequenceId)) {
		if (isCriterionChild(item)) {
			continue;
		}
		const children = criterionChildrenOf(index, item.id);
		if (children.length === 0) {
			continue;
		}
		if (descriptionHasCriteria(item)) {
			if (children.some(isOpen)) {
				workParents.push(item); // dual: close leftover open children
			}
			continue;
		}
		if (hasDuplicateIndex(children)) {
			conflicts.push({
				identifier: ident(item),
				title: item.name,
				reason: "duplicate ::ac<n> index among children (stale rename?)",
			});
			continue;
		}
		workParents.push(item);
	}

	const limit = options.limit && options.limit > 0 ? options.limit : workParents.length;
	const selected = workParents.slice(0, limit);
	const deferred = workParents.length - selected.length;

	const migrated: MigrateParentRef[] = [];
	const alreadyMigrated: MigrateParentRef[] = [];
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

		// (Conflicts were already classified out above — every parent reaching here is
		// un-migrated with unique `::ac<n>` indices.)
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
		applied: Boolean(options.apply),
	};
}
