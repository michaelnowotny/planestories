/**
 * The semantic relation requirements of every local graph answer.
 *
 * This registry is deliberately below the CLI: pure query code uses it to
 * decide whether nested dependency edges invalidate an answer, while command
 * code uses the same value to plan relation fetching and coverage selection.
 * Adding a verb without classifying it is therefore a type/test failure, not a
 * silently incomplete answer.
 */
export const GRAPH_QUERY_KINDS = [
	"ready",
	"inconsistent",
	"blocked",
	"orphans",
	"abandoned",
] as const;

export type GraphQueryKind = (typeof GRAPH_QUERY_KINDS)[number];
export type LocalQueryKind = GraphQueryKind | "critical-path";

export interface QueryRequirement {
	/** Whether the answer's truth depends on the relation graph. */
	relations: "required" | "unused";
	/** Human name used when complete relation coverage is required. */
	purpose: string;
	/** Why a partial/skipped graph remains sufficient for this answer. */
	partialReason: string;
}

const dependencyAnswer = (purpose: string): QueryRequirement => ({
	relations: "required",
	purpose,
	partialReason: "",
});

const hierarchyAnswer = (purpose: string, partialReason: string): QueryRequirement => ({
	relations: "unused",
	purpose,
	partialReason,
});

export const QUERY_REQUIREMENTS = {
	ready: dependencyAnswer("ready work"),
	inconsistent: dependencyAnswer("board consistency"),
	blocked: dependencyAnswer("blocked work"),
	orphans: dependencyAnswer("dependency orphans"),
	// The answer itself uses hierarchy only. Refresh is the deliberate exception:
	// it publishes the shared cache, so it must fetch relations or the next
	// dependency query (for example `ready`) would refuse that incomplete cache.
	abandoned: hierarchyAnswer(
		"abandoned work",
		"abandoned reads hierarchy and ancestor status, not edges",
	),
	"critical-path": dependencyAnswer("the dependency floor"),
} satisfies Record<LocalQueryKind, QueryRequirement>;

const METADATA_QUERY_REQUIREMENT = hierarchyAnswer(
	"story metadata",
	"status, metadata, effort, quality, and hierarchy predicates do not depend on relations",
);

const BLOCKED_PREDICATE_REQUIREMENT = dependencyAnswer("the --blocked predicate");

export function requirementForGraphQuery(kind: GraphQueryKind): QueryRequirement {
	return QUERY_REQUIREMENTS[kind];
}

export function requirementForStoryPredicates(predicates: { blocked?: boolean }): QueryRequirement {
	return predicates.blocked ? BLOCKED_PREDICATE_REQUIREMENT : METADATA_QUERY_REQUIREMENT;
}

export interface QueryGraphPlan {
	/** Fetch relation endpoints for this source resolution. */
	dependencies: boolean;
	/** Select `requireCompleteGraph`, rather than `acceptPartialGraph`. */
	requireComplete: boolean;
	/** A refresh promises to atomically publish a reusable complete cache. */
	writeRequired: boolean;
	purpose: string;
	partialReason: string;
}

/**
 * Plan graph acquisition from one semantic requirement.
 *
 * Refresh is an independent shared-resource requirement: even a hierarchy-only
 * answer must fetch relations and require publication because the cache is read
 * later by dependency answers. It does not change the current answer's own
 * completeness contract.
 */
export function planQueryGraph(
	requirement: QueryRequirement,
	options: { refresh?: boolean } = {},
): QueryGraphPlan {
	const refresh = options.refresh === true;
	return {
		dependencies: requirement.relations === "required" || refresh,
		requireComplete: requirement.relations === "required",
		writeRequired: refresh,
		purpose: requirement.purpose,
		partialReason: requirement.partialReason,
	};
}
