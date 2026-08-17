import { describe, expect, test } from "bun:test";
import { decideGate } from "../../../src/replicate/gate.ts";
import { sampleSnapshot } from "./fixtures.ts";

/**
 * The divergence guard.
 *
 * After a cutover the destination becomes the authoritative board and starts
 * accumulating work the snapshot has never seen — folded criteria, new tickets,
 * edits. Re-running an apply from a stale source snapshot would overwrite all of
 * it. The finance session carried that rule as a HUMAN memory ("never replicate
 * cloud→CE again"); this makes the tool enforce it.
 *
 * It is deliberately about CONTENT, not ownership. The pre-existing gate already
 * refuses a project the journal does not own — but that check is satisfied the
 * moment somebody frees the identifier, which is exactly the ritual an operator
 * learns to perform during a normal cutover. Being able to perform the ritual must
 * not be the same thing as being allowed to destroy a week of work.
 */
describe("divergence guard", () => {
	const snapshot = sampleSnapshot();

	function gate(
		targetSequenceIds: number[] | null,
		flags: Partial<{ allowDivergentTarget: boolean; recreateTarget: boolean }> = {},
	) {
		return decideGate({
			snapshot,
			destIdentifier: snapshot.project.identifier,
			destName: snapshot.project.name,
			probe: {
				dialect: "issues",
				identifierAvailable: targetSequenceIds === null,
				nameAvailable: true,
				existingProjectId: targetSequenceIds === null ? null : "target-project",
				targetSequenceIds,
				memberByEmail: {},
				sequencesMaxEver: true,
				createdAtAccepted: true,
				createdByAccepted: true,
				commentCreatedAtAccepted: true,
				archivedEndpoint: "listed",
				archiveVerb: true,
				rejectedRelationKinds: [],
			},
			flags: {
				allowSqlFinalize: false,
				noExactIdentifiers: false,
				assumeGapsDeleted: false,
				recreateTarget: false,
				...flags,
			},
			resume: { journalOwnsProject: "target-project" },
		} as never);
	}

	const snapshotSequences = snapshot.items.map((item) => item.sequenceId);

	test("an empty destination is fine (the normal first migration)", () => {
		expect(gate(null).ok).toBe(true);
	});

	test("a destination holding exactly the snapshot's items is fine (resume / re-run)", () => {
		expect(gate(snapshotSequences).ok).toBe(true);
	});

	test("REFUSES when the destination holds items the snapshot has never seen", () => {
		const decision = gate([...snapshotSequences, 9001, 9002, 9003]);
		expect(decision.ok).toBe(false);
		const message = decision.errors.join(" ");
		// The message must name the count and some examples: an operator has to be
		// able to recognise their own work in it.
		expect(message).toMatch(/3/);
		expect(message).toMatch(/9001/);
		expect(message).toMatch(/--allow-divergent-target/);
	});

	test("the explicit override proceeds, but records a warning", () => {
		const decision = gate([...snapshotSequences, 9001], { allowDivergentTarget: true });
		expect(decision.ok).toBe(true);
		expect(decision.warnings.join(" ")).toMatch(/diverg/i);
	});

	test("--recreate-target is itself divergence-blind, so it must NOT bypass the guard", () => {
		// Recreating the target destroys exactly the items the guard is protecting.
		const decision = gate([...snapshotSequences, 9001], { recreateTarget: true });
		expect(decision.ok).toBe(false);
	});

	test("an unknown target inventory does not silently pass (fail closed)", () => {
		// If the probe could not enumerate the destination we must not pretend it is
		// empty — that is the assumption that would license the overwrite.
		const decision = gate(undefined as unknown as number[]);
		expect(decision.ok).toBe(false);
		expect(decision.errors.join(" ")).toMatch(/could not|unknown|verify/i);
	});
});
