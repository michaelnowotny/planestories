import { ConfigError } from "../errors.ts";
import { formatDevDays, parseEffortDays } from "../markdown/directives.ts";
import type { PlaneClient } from "../plane/client.ts";
import { type FetchedWorkItem, fetchProjectIndex, type ProjectIndex } from "../plane/issues.ts";
import { Resolver } from "../plane/resolvers.ts";
import type { ResolvedConfig } from "../types.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import { collectDescendants, isEpic } from "./packet.ts";

/** A closed state group (mirrors packet/groomer): a cancelled item is resolved, not pending. */
const COMPLETED_GROUP = "completed";
const CANCELLED_GROUP = "cancelled";

/** A child referenced in the blocked/blocking lists. */
export interface RollupChildRef {
	identifier: string;
	title: string;
	status: string | null;
}

export interface EpicRollup {
	identifier: string;
	title: string;
	status: string | null;
	/** Non-criterion descendants that are themselves epics (structural, not work). */
	subEpics: number;
	/** Leaf (non-epic) descendant stories — the actual work items. */
	leafTotal: number;
	/** Count of leaf stories per state group (backlog/unstarted/started/completed/cancelled/…). */
	byStateGroup: Record<string, number>;
	/** Completed leaf stories. */
	completed: number;
	/** Cancelled leaf stories (excluded from the completion denominator). */
	cancelled: number;
	/**
	 * Completion over ACTIVE work: completed / (leafTotal − cancelled). Null when
	 * there is no active work to complete (0 leaves, or all cancelled).
	 */
	completionPct: number | null;
	/** Σ effort over leaf stories that HAVE an effort (a lower bound when some lack it). */
	totalEffortDays: number;
	/** Leaf stories with no effort estimate — makes totalEffortDays a lower bound. */
	missingEffort: number;
	/** Leaf stories that are ACTIVELY blocked (a blocker that isn't done/cancelled). */
	blocked: RollupChildRef[];
	/** Leaf stories that ACTIVELY block something (a blocked item that isn't done/cancelled). */
	blocking: RollupChildRef[];
}

export interface RollupOptions {
	config: ResolvedConfig;
	/** The Plane identifier of the epic (e.g. DATA-1). */
	identifier: string;
	project?: string;
}

function childRef(item: FetchedWorkItem, projectIdentifier: string): RollupChildRef {
	return {
		identifier: `${projectIdentifier}-${item.sequenceId}`,
		title: item.name,
		status: item.stateName ?? null,
	};
}

/**
 * Summarize an epic: work-item status breakdown, completion %, total effort (with
 * a missing-estimate count), and the blocked/blocking leaf stories. Read-only.
 *
 * "Leaf" = a non-epic descendant (the actual work); sub-epics are structural and
 * counted separately. The whole subtree is included (nested epics), reusing the
 * same descendant collection as `packet`.
 */
export async function rollupEpic(
	client: PlaneClient,
	options: RollupOptions,
): Promise<{ rollup: EpicRollup; text: string }> {
	const resolver = new Resolver(client);
	const projectName = options.project ?? options.config.defaultProject;
	if (!projectName) {
		throw new ConfigError(
			"No project specified for epic rollup. Provide --project or set defaultProject in config.",
		);
	}
	const project = await resolver.resolveProject(projectName);
	const index: ProjectIndex = await fetchProjectIndex(client, project.id, project.identifier);

	const target = index.byIdentifier.get(options.identifier.trim().toUpperCase());
	if (!target) {
		throw new ConfigError(
			`Work item ${options.identifier} not found in project ${project.identifier}.`,
		);
	}
	if (!isEpic(target, index)) {
		throw new ConfigError(
			`${options.identifier} is not an epic (it parents no non-criterion children).`,
		);
	}

	const descendants = collectDescendants(target, index);
	const leaves = descendants.filter((d) => !isEpic(d, index));
	const subEpics = descendants.length - leaves.length;

	const byStateGroup: Record<string, number> = {};
	for (const leaf of leaves) {
		const group = leaf.stateGroup ?? "unknown";
		byStateGroup[group] = (byStateGroup[group] ?? 0) + 1;
	}
	const completed = leaves.filter((l) => l.stateGroup === COMPLETED_GROUP).length;
	const cancelled = leaves.filter((l) => l.stateGroup === CANCELLED_GROUP).length;
	const active = leaves.length - cancelled;
	const completionPct = active > 0 ? (completed / active) * 100 : null;

	const efforts = leaves.map((l) => parseEffortDays(l.description ?? ""));
	// Round off IEEE noise so the structured field matches the displayed value
	// (0.1 + 0.2 -> 0.3 in the object too, not 0.30000000000000004).
	const totalEffortDays = Number(
		formatDevDays(efforts.reduce<number>((sum, e) => sum + (e ?? 0), 0)),
	);
	const missingEffort = efforts.filter((e) => e === null).length;

	// A dependency that is itself closed (done/cancelled) or unresolvable-as-closed no
	// longer gates work, so it doesn't make the story ACTIVELY blocked/blocking. An
	// unresolved target is treated as active (conservative — we can't prove it's closed).
	const isTargetActive = (ids: string[]): boolean =>
		ids.some((id) => {
			const it = index.byId.get(id);
			return !it || !(it.stateGroup === COMPLETED_GROUP || it.stateGroup === CANCELLED_GROUP);
		});

	// Relations only for leaf stories, to find which are actively blocked / blocking. Bounded.
	const relationPairs = await mapWithConcurrency(leaves, 6, async (leaf) => {
		const relations = await client.getRelations(project.id, leaf.id);
		return [leaf.id, relations] as const;
	});
	const relationsById = new Map(relationPairs);
	const blocked: RollupChildRef[] = [];
	const blocking: RollupChildRef[] = [];
	for (const leaf of leaves) {
		// A finished (done/cancelled) leaf is neither blocked nor blocking — it needs
		// nothing and, being complete, no longer holds anything up.
		if (leaf.stateGroup === COMPLETED_GROUP || leaf.stateGroup === CANCELLED_GROUP) {
			continue;
		}
		const rel = relationsById.get(leaf.id);
		if (rel && isTargetActive(rel.blocked_by ?? [])) {
			blocked.push(childRef(leaf, project.identifier));
		}
		if (rel && isTargetActive(rel.blocking ?? [])) {
			blocking.push(childRef(leaf, project.identifier));
		}
	}

	const rollup: EpicRollup = {
		identifier: `${project.identifier}-${target.sequenceId}`,
		title: target.name,
		status: target.stateName ?? null,
		subEpics,
		leafTotal: leaves.length,
		byStateGroup,
		completed,
		cancelled,
		completionPct,
		totalEffortDays,
		missingEffort,
		blocked,
		blocking,
	};

	return { rollup, text: renderRollup(rollup) };
}

/** Render a rollup to a concise, human-readable summary. */
export function renderRollup(r: EpicRollup): string {
	const lines: string[] = [];
	lines.push(`${r.identifier} — ${r.title}  [${r.status ?? "unknown"}]`);
	lines.push("");
	// Floor, not round — never claim 100% while any active story is unfinished
	// (Math.round(99.5) would read "100% complete").
	const pct = r.completionPct === null ? "n/a" : `${Math.floor(r.completionPct)}%`;
	lines.push(
		`  Stories: ${r.leafTotal} (${r.completed} done${
			r.cancelled > 0 ? `, ${r.cancelled} cancelled` : ""
		}) — ${pct} complete${r.subEpics > 0 ? ` · ${r.subEpics} sub-epic(s)` : ""}`,
	);

	const groups = Object.keys(r.byStateGroup).sort();
	if (groups.length > 0) {
		const breakdown = groups.map((g) => `${g}: ${r.byStateGroup[g]}`).join(", ");
		lines.push(`  By status: ${breakdown}`);
	}

	const effort =
		r.missingEffort > 0
			? `${formatDevDays(r.totalEffortDays)} dev-days (lower bound; ${r.missingEffort} story(ies) unestimated)`
			: `${formatDevDays(r.totalEffortDays)} dev-days`;
	lines.push(`  Effort: ${effort}`);

	if (r.blocked.length > 0) {
		lines.push(`  Blocked (${r.blocked.length}): ${r.blocked.map((c) => c.identifier).join(", ")}`);
	}
	if (r.blocking.length > 0) {
		lines.push(
			`  Blocking (${r.blocking.length}): ${r.blocking.map((c) => c.identifier).join(", ")}`,
		);
	}
	return lines.join("\n");
}
