import { describe, expect, test } from "bun:test";
import { decideGate, type GateFlags } from "../../../src/replicate/gate.ts";
import type { TargetProbeResult } from "../../../src/replicate/probe.ts";
import { sampleSnapshot } from "./fixtures.ts";

const flags: GateFlags = {
	allowSqlFinalize: false,
	noExactIdentifiers: false,
	assumeGapsDeleted: false,
	recreateTarget: false,
};

function probe(overrides: Partial<TargetProbeResult> = {}): TargetProbeResult {
	return {
		dialect: "issues",
		identifierAvailable: true,
		existingProjectId: null,
		memberByEmail: { "mapped@example.test": "target-user" },
		sequencesMaxEver: true,
		createdAtAccepted: true,
		createdByAccepted: true,
		commentCreatedAtAccepted: true,
		commentCreatedByAccepted: true,
		relationKindsAccepted: ["blocked_by", "relates_to", "start_before"],
		archiveVerbAccepted: true,
		stateWriteAccepted: true,
		...overrides,
	};
}

describe("replication pre-write gate", () => {
	test("max-ever failure names both explicit rerun flags", () => {
		const decision = decideGate({
			snapshot: sampleSnapshot(),
			probe: probe({ sequencesMaxEver: false }),
			flags,
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(decision.ok).toBeFalse();
		expect(decision.errors.join(" ")).toContain("--allow-sql-finalize");
		expect(decision.errors.join(" ")).toContain("--no-exact-identifiers");
	});

	test("renumber mode permits a non-max-ever target", () => {
		const decision = decideGate({
			snapshot: sampleSnapshot(),
			probe: probe({ sequencesMaxEver: false }),
			flags: { ...flags, noExactIdentifiers: true },
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(decision.ok).toBeTrue();
		expect(decision.mode).toBe("renumber");
	});

	test("SQL finalize remains an explicit fail-closed scope cut", () => {
		const decision = decideGate({
			snapshot: sampleSnapshot(),
			probe: probe({ sequencesMaxEver: false }),
			flags: { ...flags, allowSqlFinalize: true },
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(decision.errors.join(" ")).toContain("not implemented in this build");
	});

	test("archived-unavailable gaps require the explicit assumption flag", () => {
		const snapshot = sampleSnapshot();
		snapshot.source.archivedInventory = "unavailable";
		const blocked = decideGate({
			snapshot,
			probe: probe(),
			flags,
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(blocked.errors.join(" ")).toContain("--assume-gaps-deleted");
		const allowed = decideGate({
			snapshot,
			probe: probe(),
			flags: { ...flags, assumeGapsDeleted: true },
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(allowed.ok).toBeTrue();
	});

	test("unmappable authors and assignees are degradations, not errors", () => {
		const decision = decideGate({
			snapshot: sampleSnapshot(),
			probe: probe(),
			flags,
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		});
		expect(decision.ok).toBeTrue();
		expect(
			decision.manifests.degradations.some((entry) => entry.feature === "authorship"),
		).toBeTrue();
	});
});
