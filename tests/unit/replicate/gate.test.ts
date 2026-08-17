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

describe("loss report — activity", () => {
	/**
	 * The loss report must describe what THIS snapshot holds. Before
	 * --with-activity existed, one grouped line said activity was "not
	 * inventoried … not carried and not counted per item". That sentence becomes
	 * FALSE for a captured snapshot — the trail is carried and counted, it is
	 * simply never replayed — and a loss report that misstates its own contents
	 * is exactly the kind of confidently-wrong artifact the house rules ban.
	 */
	function losses(snapshot = sampleSnapshot()) {
		return decideGate({
			snapshot,
			probe: probe(),
			flags,
			resume: { journalOwnsProject: null },
			destIdentifier: "DST",
		}).manifests.losses;
	}

	test("an uncaptured snapshot says so, and points at the flag", () => {
		const entry = losses().find((loss) => loss.feature === "activity/audit log");
		expect(entry?.detail).toContain("--with-activity");
		expect(entry?.detail).toContain("never replayed");
	});

	test("a captured snapshot reports the real entry count, not 'not inventoried'", () => {
		const snapshot = sampleSnapshot();
		snapshot.source.activityInventory = "captured";
		snapshot.activities = {
			"source-1": [
				{
					id: "a1",
					verb: "created",
					field: null,
					oldValue: null,
					newValue: null,
					oldIdentifier: null,
					newIdentifier: null,
					actor: null,
					createdAt: "2025-01-01T00:00:00Z",
					comment: null,
					issueComment: null,
				},
				{
					id: "a2",
					verb: "updated",
					field: "state",
					oldValue: null,
					newValue: null,
					oldIdentifier: null,
					newIdentifier: null,
					actor: null,
					createdAt: "2025-01-02T00:00:00Z",
					comment: null,
					issueComment: null,
				},
			],
		};
		const entry = losses(snapshot).find((loss) => loss.feature === "activity/audit log");
		expect(entry?.count).toBe(2);
		expect(entry?.detail).toContain("NOT replayed");
		// The stale grouped wording must not resurface and re-claim activity.
		expect(losses(snapshot).map((loss) => loss.feature)).not.toContain(
			"attachments/activity/reactions",
		);
	});
});

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
