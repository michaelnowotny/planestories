import { classifyFileEpics } from "../atlas/model.ts";
import { splitBody } from "../markdown/criteria.ts";
import { fenceMask } from "../markdown/directives.ts";
import type { UserStory } from "../types.ts";

export type LintSeverity = "error" | "warning";

export type LintRule =
	| "missing-acceptance-criteria"
	| "missing-effort"
	| "epic-missing-why"
	| "epic-has-acceptance-criteria"
	| "dependency-self-reference"
	| "dependency-cycle"
	| "duplicate-identifier"
	| "dangling-reference"
	| "orphan-criterion"
	| "bad-parent"
	/** The file could not be parsed at all — reported rather than crashing the run. */
	| "unparseable-file"
	/** A `blocked_by`/`blocks` between an item and its own parent chain. */
	| "dependency-nested";

/**
 * Every rule name, in one place.
 *
 * `repo_config.ts` kept a hand-copied duplicate for validating `lint.disable`,
 * and it went stale the moment a rule was added: `.planestories.yml` with
 * `lint.disable: [dependency-nested]` failed startup with "unknown rule" — which
 * was false, since the rule exists and runs. Exported so there is one list to
 * keep current, not two.
 */
export const ALL_LINT_RULES = [
	"missing-acceptance-criteria",
	"missing-effort",
	"epic-missing-why",
	"epic-has-acceptance-criteria",
	"dependency-self-reference",
	"dependency-cycle",
	"dependency-nested",
	"duplicate-identifier",
	"dangling-reference",
	"orphan-criterion",
	"bad-parent",
	"unparseable-file",
] as const satisfies readonly LintRule[];

export interface LintStory {
	filePath: string;
	story: UserStory;
}

export interface LintFinding {
	filePath: string;
	/** Null when the finding is about the FILE, not a story inside it. */
	story: UserStory | null;
	severity: LintSeverity;
	rule: LintRule;
	message: string;
}

export interface RuleContext {
	stories: readonly LintStory[];
	byExactIdentifier: ReadonlyMap<string, LintStory>;
	byNormalizedIdentifier: ReadonlyMap<string, LintStory>;
	epics: ReadonlySet<UserStory>;
}

function normalizeIdentifier(identifier: string | null): string | null {
	const normalized = identifier?.trim().toUpperCase();
	return normalized || null;
}

function error(entry: LintStory, rule: LintRule, message: string): LintFinding {
	return {
		filePath: entry.filePath,
		story: entry.story,
		severity: "error",
		rule,
		message,
	};
}

function warning(entry: LintStory, rule: LintRule, message: string): LintFinding {
	return {
		filePath: entry.filePath,
		story: entry.story,
		severity: "warning",
		rule,
		message,
	};
}

/** Non-epic stories must carry inline or child-item acceptance criteria. */
export function checkMissingAcceptanceCriteria(context: RuleContext): LintFinding[] {
	const criterionParents = new Set(
		context.stories
			.filter((entry) => entry.story.kind === "criterion")
			.map((entry) => entry.story.parent)
			.filter((identifier): identifier is string => identifier !== null),
	);

	return context.stories
		.filter(
			(entry) =>
				entry.story.kind !== "criterion" &&
				!context.epics.has(entry.story) &&
				splitBody(entry.story.body).criteria.length === 0 &&
				!(entry.story.planeIdentifier && criterionParents.has(entry.story.planeIdentifier)),
		)
		.map((entry) =>
			error(
				entry,
				"missing-acceptance-criteria",
				"Non-epic stories need inline acceptance criteria or a criterion child.",
			),
		);
}

/** Non-epic stories must have a developer-day effort value. */
export function checkMissingEffort(context: RuleContext): LintFinding[] {
	return context.stories
		.filter(
			(entry) =>
				entry.story.kind !== "criterion" &&
				!context.epics.has(entry.story) &&
				entry.story.effortDays === null,
		)
		.map((entry) => error(entry, "missing-effort", "Non-epic stories need an **Effort:** value."));
}

const WHY_HEADING = /^#{1,6}\s+why is this needed\?\s*#*\s*$/im;

function hasWhyHeading(body: string): boolean {
	const lines = body.split("\n");
	const mask = fenceMask(lines);
	return lines.some((line, index) => !mask[index] && WHY_HEADING.test(line));
}

/** Epics must explain why they are needed in a Markdown heading section. */
export function checkEpicMissingWhy(context: RuleContext): LintFinding[] {
	return context.stories
		.filter((entry) => context.epics.has(entry.story) && !hasWhyHeading(entry.story.body))
		.map((entry) =>
			error(entry, "epic-missing-why", "Epics need a “Why is this needed?” Markdown heading."),
		);
}

/** Epics describe scope; acceptance criteria belong on their child stories. */
export function checkEpicHasAcceptanceCriteria(context: RuleContext): LintFinding[] {
	return context.stories
		.filter(
			(entry) => context.epics.has(entry.story) && splitBody(entry.story.body).criteria.length > 0,
		)
		.map((entry) =>
			error(
				entry,
				"epic-has-acceptance-criteria",
				"Epics must not carry inline acceptance criteria.",
			),
		);
}

/**
 * The parser records raw self-references before removing them from normalized
 * relation sets. Consume those retained findings so authoring mistakes remain
 * visible without parsing markdown a second, subtly different way.
 */
export function checkDependencySelfReference(context: RuleContext): LintFinding[] {
	return context.stories
		.filter((entry) => (entry.story.relationValidationErrors?.length ?? 0) > 0)
		.map((entry) =>
			error(
				entry,
				"dependency-self-reference",
				entry.story.relationValidationErrors?.join("; ") ?? "A work item cannot reference itself.",
			),
		);
}

/**
 * A dependency between an item and its own ancestor or descendant, caught at
 * AUTHORING time.
 *
 * The dependency verbs already refuse to answer once such an edge exists,
 * because it cannot be projected onto leaves without inventing constraints
 * nobody declared. But planestories would happily CREATE one from a story file:
 * `parent: EPIC-1` plus `blocked_by: [EPIC-1]` passed lint, and Plane's API
 * accepts it (verified — HTTP 201). A tool that declines to read a state it will
 * write is incoherent; this closes the other half.
 */
export function checkDependencyNested(context: RuleContext): LintFinding[] {
	const parentOf = new Map<string, string>();
	for (const entry of context.stories) {
		const id = entry.story.planeIdentifier?.trim().toUpperCase();
		const parent = entry.story.parent?.trim().toUpperCase();
		if (id && parent) parentOf.set(id, parent);
	}
	const ancestors = (id: string): Set<string> => {
		const seen = new Set<string>();
		let cursor = parentOf.get(id);
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			cursor = parentOf.get(cursor);
		}
		return seen;
	};

	const findings: LintFinding[] = [];
	for (const entry of context.stories) {
		const id = entry.story.planeIdentifier?.trim().toUpperCase();
		const parent = entry.story.parent?.trim().toUpperCase();
		// A story has NO identifier until the first import writes one back — which
		// is exactly when this rule matters, because the file is being authored.
		// Requiring an id made the rule fire only on work already on the board, so
		// it prevented nothing on the path it was built for. The parent chain is
		// reachable from `parent:` alone.
		const up = id ? ancestors(id) : parent ? new Set([parent, ...ancestors(parent)]) : new Set();
		if (up.size === 0) continue;
		const related = [...(entry.story.blockedBy ?? []), ...(entry.story.blocks ?? [])].map((value) =>
			value.trim().toUpperCase(),
		);
		for (const other of related) {
			const nested = up.has(other) || (id !== undefined && ancestors(other).has(id));
			if (!nested) continue;
			findings.push(
				error(
					entry,
					"dependency-nested",
					`${id ?? entry.story.title} declares a dependency on ${other}, which is in its own parent chain. ` +
						"Such a relation cannot be read as a schedule constraint — expanding it would invent constraints between siblings — so the dependency commands refuse to answer once it exists. " +
						"Remove the relation, or re-parent one of the two.",
				),
			);
		}
	}
	return findings;
}

interface DependencyGraph {
	nodes: string[];
	edges: Map<string, Set<string>>;
}

function buildDependencyGraph(context: RuleContext): DependencyGraph {
	const nodes = [...context.byNormalizedIdentifier.keys()];
	const edges = new Map(nodes.map((identifier) => [identifier, new Set<string>()]));

	for (const { story } of context.stories) {
		const own = normalizeIdentifier(story.planeIdentifier);
		if (!own) {
			continue;
		}
		for (const blocker of story.blockedBy) {
			const target = normalizeIdentifier(blocker);
			if (target && edges.has(target)) {
				edges.get(target)?.add(own);
			}
		}
		for (const blocked of story.blocks) {
			const target = normalizeIdentifier(blocked);
			if (target && edges.has(target)) {
				edges.get(own)?.add(target);
			}
		}
	}

	return { nodes, edges };
}

/**
 * Return strongly connected components in deterministic input order. A
 * component with more than one identifier represents a dependency cycle.
 */
function cyclicComponents(graph: DependencyGraph): string[][] {
	let nextIndex = 0;
	const indices = new Map<string, number>();
	const lowLinks = new Map<string, number>();
	const componentStack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	const inputOrder = new Map(graph.nodes.map((identifier, index) => [identifier, index]));

	interface VisitFrame {
		node: string;
		parent: string | null;
		targets: string[];
		nextTarget: number;
	}

	const discover = (node: string, parent: string | null): VisitFrame => {
		indices.set(node, nextIndex);
		lowLinks.set(node, nextIndex);
		nextIndex += 1;
		componentStack.push(node);
		onStack.add(node);
		return {
			node,
			parent,
			targets: [...(graph.edges.get(node) ?? [])],
			nextTarget: 0,
		};
	};

	for (const root of graph.nodes) {
		if (indices.has(root)) {
			continue;
		}
		const visitStack: VisitFrame[] = [discover(root, null)];
		while (visitStack.length > 0) {
			const frame = visitStack[visitStack.length - 1] as VisitFrame;
			const target = frame.targets[frame.nextTarget];
			if (target !== undefined) {
				frame.nextTarget += 1;
				if (!indices.has(target)) {
					visitStack.push(discover(target, frame.node));
				} else if (onStack.has(target)) {
					lowLinks.set(
						frame.node,
						Math.min(lowLinks.get(frame.node) as number, indices.get(target) as number),
					);
				}
				continue;
			}

			visitStack.pop();
			if (frame.parent !== null) {
				lowLinks.set(
					frame.parent,
					Math.min(lowLinks.get(frame.parent) as number, lowLinks.get(frame.node) as number),
				);
			}

			if (lowLinks.get(frame.node) === indices.get(frame.node)) {
				const component: string[] = [];
				while (componentStack.length > 0) {
					const member = componentStack.pop() as string;
					onStack.delete(member);
					component.push(member);
					if (member === frame.node) {
						break;
					}
				}
				if (component.length > 1) {
					component.sort((a, b) => (inputOrder.get(a) as number) - (inputOrder.get(b) as number));
					components.push(component);
				}
			}
		}
	}
	return components.sort(
		(a, b) =>
			(inputOrder.get(a[0] as string) as number) - (inputOrder.get(b[0] as string) as number),
	);
}

/** The combined blocked_by/blocks graph must be acyclic. */
export function checkDependencyCycles(context: RuleContext): LintFinding[] {
	return cyclicComponents(buildDependencyGraph(context)).flatMap((component) =>
		component.map((identifier) =>
			error(
				context.byNormalizedIdentifier.get(identifier) as LintStory,
				"dependency-cycle",
				`Dependency cycle detected among ${component.join(", ")}.`,
			),
		),
	);
}

/** Plane identifiers must identify exactly one story in the passed fileset. */
export function checkDuplicateIdentifiers(context: RuleContext): LintFinding[] {
	const entriesByIdentifier = new Map<string, LintStory[]>();
	for (const entry of context.stories) {
		const identifier = normalizeIdentifier(entry.story.planeIdentifier);
		if (!identifier) {
			continue;
		}
		const entries = entriesByIdentifier.get(identifier) ?? [];
		entries.push(entry);
		entriesByIdentifier.set(identifier, entries);
	}

	return [...entriesByIdentifier.entries()].flatMap(([identifier, entries]) =>
		entries.length > 1
			? entries.map((entry) =>
					error(
						entry,
						"duplicate-identifier",
						`Identifier ${identifier} is declared ${entries.length} times in the passed fileset.`,
					),
				)
			: [],
	);
}

/** References outside the passed fileset are warnings because they may exist on Plane. */
export function checkDanglingReferences(context: RuleContext): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const entry of context.stories) {
		const parentIdentifier = entry.story.parent;
		if (parentIdentifier && !context.byExactIdentifier.has(parentIdentifier)) {
			findings.push(
				warning(
					entry,
					"dangling-reference",
					`parent references ${parentIdentifier}, which is not in the passed fileset.`,
				),
			);
		}
		const references: Array<[string, string]> = [
			...entry.story.blockedBy.map((identifier): [string, string] => ["blocked_by", identifier]),
			...entry.story.blocks.map((identifier): [string, string] => ["blocks", identifier]),
			...entry.story.relatesTo.map((identifier): [string, string] => ["relates_to", identifier]),
		];
		for (const [field, rawIdentifier] of references) {
			const identifier = normalizeIdentifier(rawIdentifier);
			if (identifier && !context.byNormalizedIdentifier.has(identifier)) {
				findings.push(
					warning(
						entry,
						"dangling-reference",
						`${field} references ${identifier}, which is not in the passed fileset.`,
					),
				);
			}
		}
	}
	return findings;
}

/** Criterion items must resolve to a parent story in the passed fileset. */
export function checkOrphanCriteria(context: RuleContext): LintFinding[] {
	return context.stories
		.filter((entry) => {
			if (entry.story.kind !== "criterion") {
				return false;
			}
			const parentIdentifier = entry.story.parent;
			const parent = parentIdentifier ? context.byExactIdentifier.get(parentIdentifier) : undefined;
			return !parent || parent.story.kind === "criterion" || context.epics.has(parent.story);
		})
		.map((entry) => {
			const parentIdentifier = entry.story.parent;
			const parent = parentIdentifier ? context.byExactIdentifier.get(parentIdentifier) : undefined;
			let message = "Criteria need a parent identifier.";
			if (parentIdentifier && !parent) {
				message = `Criterion parent ${parentIdentifier} is not in the passed fileset.`;
			} else if (parentIdentifier) {
				message = `Criterion parent ${parentIdentifier} does not resolve to a non-epic story.`;
			}
			return error(entry, "orphan-criterion", message);
		});
}

/** Resolved parents of non-criterion stories must be classified as epics. */
export function checkBadParents(context: RuleContext): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const entry of context.stories) {
		if (entry.story.kind === "criterion") {
			continue;
		}
		const parentIdentifier = entry.story.parent;
		if (!parentIdentifier) {
			continue;
		}
		const parent = context.byExactIdentifier.get(parentIdentifier);
		if (parent && !context.epics.has(parent.story)) {
			findings.push(
				error(entry, "bad-parent", `Parent ${parentIdentifier} resolves to a non-epic story.`),
			);
		}
	}
	return findings;
}

/** Run every mechanical rule against one combined, cross-file story set. */
export function createRuleContext(stories: readonly LintStory[]): RuleContext {
	const byExactIdentifier = new Map<string, LintStory>();
	const byNormalizedIdentifier = new Map<string, LintStory>();
	for (const entry of stories) {
		const exactIdentifier = entry.story.planeIdentifier;
		if (exactIdentifier && !byExactIdentifier.has(exactIdentifier)) {
			byExactIdentifier.set(exactIdentifier, entry);
		}
		const normalizedIdentifier = normalizeIdentifier(exactIdentifier);
		if (normalizedIdentifier && !byNormalizedIdentifier.has(normalizedIdentifier)) {
			byNormalizedIdentifier.set(normalizedIdentifier, entry);
		}
	}
	return {
		stories,
		byExactIdentifier,
		byNormalizedIdentifier,
		epics: classifyFileEpics(stories.map((entry) => entry.story)),
	};
}

/** Run every mechanical rule against one combined, cross-file story set. */
export function runLintRules(stories: readonly LintStory[]): LintFinding[] {
	const context = createRuleContext(stories);
	return [
		...checkMissingAcceptanceCriteria(context),
		...checkMissingEffort(context),
		...checkEpicMissingWhy(context),
		...checkEpicHasAcceptanceCriteria(context),
		...checkDependencySelfReference(context),
		...checkDependencyNested(context),
		...checkDependencyCycles(context),
		...checkDuplicateIdentifiers(context),
		...checkDanglingReferences(context),
		...checkOrphanCriteria(context),
		...checkBadParents(context),
	];
}
