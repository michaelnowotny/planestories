import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerGraphQueryCommands } from "../../../src/cli/commands/graph-queries.ts";
import {
	GRAPH_QUERY_KINDS,
	planQueryGraph,
	requirementForGraphQuery,
	requirementForStoryPredicates,
} from "../../../src/sync/query_requirements.ts";

/** Literal oracle: do not derive expected relation use from the registry under test. */
const GRAPH_VERBS = [
	["ready", true],
	["inconsistent", true],
	["blocked", true],
	["orphans", true],
	["abandoned", false],
] as const;

describe("local-query relation requirements", () => {
	test("every graph verb has one explicit semantic requirement", () => {
		expect(GRAPH_QUERY_KINDS.join(",")).toBe(GRAPH_VERBS.map(([kind]) => kind).join(","));
		for (const [kind, needsRelations] of GRAPH_VERBS) {
			const requirement = requirementForGraphQuery(kind);
			expect(requirement.relations === "required").toBe(needsRelations);
			const ordinary = planQueryGraph(requirement);
			expect(ordinary.dependencies).toBe(needsRelations);
			expect(ordinary.requireComplete).toBe(needsRelations);
			expect(ordinary.writeRequired).toBe(false);
		}
	});

	test("refresh fetches relations and requires cache publication without changing answer semantics", () => {
		for (const [kind, needsRelations] of GRAPH_VERBS) {
			const refresh = planQueryGraph(requirementForGraphQuery(kind), { refresh: true });
			expect(refresh.dependencies).toBe(true);
			expect(refresh.writeRequired).toBe(true);
			expect(refresh.requireComplete).toBe(needsRelations);
		}
	});

	test("ls/count need relations exactly when --blocked survives predicate mapping", () => {
		for (const blocked of [false, true]) {
			const requirement = requirementForStoryPredicates({ blocked });
			const ordinary = planQueryGraph(requirement);
			expect(ordinary.dependencies).toBe(blocked);
			expect(ordinary.requireComplete).toBe(blocked);
		}
		const refresh = planQueryGraph(requirementForStoryPredicates({ blocked: false }), {
			refresh: true,
		});
		expect(refresh).toMatchObject({
			dependencies: true,
			requireComplete: false,
			writeRequired: true,
		});
	});

	test("every registered graph-query command is classified", () => {
		const program = new Command();
		registerGraphQueryCommands(program);
		const registered = program.commands.map((command) => command.name());
		expect(registered).toEqual([...GRAPH_QUERY_KINDS]);
	});
});
