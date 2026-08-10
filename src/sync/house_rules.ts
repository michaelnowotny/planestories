import {
	fenceMask,
	normalizeRelationIdentifiers,
	parseEffortDays,
	parseRelationIdentifiers,
} from "../markdown/directives.ts";
import type { PlaneIssueRelations } from "../plane/client.ts";
import type { ProjectIndex } from "../plane/issues.ts";
import { isCriterionChild, resolveStoryRelationIdentifiers } from "./board-story.ts";
import { isEpic } from "./packet.ts";

export interface HouseRuleFindings {
	missingEffort: Array<{ identifier: string; title: string }>;
	proseDepsWithoutRelation: Array<{
		identifier: string;
		title: string;
		directive: "depends on" | "blocks";
		missing: string[];
		unknownTargets: string[];
	}>;
}

const OPEN_GROUPS = new Set(["backlog", "unstarted", "started"]);
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const DEPENDENCY_LINE =
	/^ {0,3}(?:\*\*|__)?(depends on|blocks)(?:\*\*|__)?:(?:\*\*|__)?[ \t]*(.*?)[ \t]*$/i;

export function checkHouseRules(
	index: ProjectIndex,
	relations: Map<string, PlaneIssueRelations>,
	projectIdentifier: string,
): HouseRuleFindings {
	const missingEffort: HouseRuleFindings["missingEffort"] = [];
	const proseDepsWithoutRelation: HouseRuleFindings["proseDepsWithoutRelation"] = [];

	for (const item of index.items) {
		if (isCriterionChild(item) || !item.stateGroup || !OPEN_GROUPS.has(item.stateGroup)) continue;
		const identifier = `${projectIdentifier}-${item.sequenceId}`;
		if (!isEpic(item, index) && parseEffortDays(item.description ?? "") === null) {
			missingEffort.push({ identifier, title: item.name });
		}

		const boardRelations = resolveStoryRelationIdentifiers(
			relations.get(item.id) ?? {
				blocking: [],
				blocked_by: [],
				relates_to: [],
				duplicate: [],
				start_before: [],
				start_after: [],
				finish_before: [],
				finish_after: [],
			},
			index,
			projectIdentifier,
		);
		const lines = (item.description ?? "").split("\n");
		const mask = fenceMask(lines);
		const declaredByDirective = new Map<"depends on" | "blocks", string[]>();
		for (let i = 0; i < lines.length; i++) {
			if (mask[i]) continue;
			const match = (lines[i] as string).match(DEPENDENCY_LINE);
			if (!match) continue;
			const declared = normalizeRelationIdentifiers(parseRelationIdentifiers(match[2])).filter(
				(id) => IDENTIFIER.test(id),
			);
			if (declared.length === 0) continue;
			const directive = (match[1] as string).toLowerCase() as "depends on" | "blocks";
			declaredByDirective.set(directive, [
				...(declaredByDirective.get(directive) ?? []),
				...declared,
			]);
		}
		for (const [directive, values] of declaredByDirective) {
			const declared = normalizeRelationIdentifiers(values);
			const actual = new Set(
				directive === "depends on" ? boardRelations.blockedBy : boardRelations.blocks,
			);
			const unknownTargets = declared.filter((id) => !index.byIdentifier.has(id));
			const missing = declared.filter((id) => index.byIdentifier.has(id) && !actual.has(id));
			if (missing.length || unknownTargets.length) {
				proseDepsWithoutRelation.push({
					identifier,
					title: item.name,
					directive,
					missing,
					unknownTargets,
				});
			}
		}
	}

	return { missingEffort, proseDepsWithoutRelation };
}
