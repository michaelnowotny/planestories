import { describe, expect, test } from "bun:test";
import { probeTargetEmpirical, probeTargetReadOnly } from "../../../src/replicate/probe.ts";
import { formatApplyReport, formatSnapshotSummary } from "../../../src/replicate/report.ts";
import { FakePlane } from "./fake-plane.ts";
import { sampleSnapshot } from "./fixtures.ts";

describe("target probe", () => {
	test("confirms max-ever semantics and cleans up its own temporary project", async () => {
		const fake = new FakePlane();
		fake.rejectedRelationKinds.add("start_before");
		const readOnly = await probeTargetReadOnly(fake, "DST");
		const result = await probeTargetEmpirical(
			fake,
			readOnly,
			{ relationKinds: ["blocked_by", "start_before"], archived: true, anyComments: true },
			{ randomDigits: () => "1234" },
		);
		expect(result.sequencesMaxEver).toBeTrue();
		expect(result.createdAtAccepted).toBeTrue();
		expect(result.createdByAccepted).toBeTrue();
		expect(result.commentCreatedAtAccepted).toBeTrue();
		expect(result.commentCreatedByAccepted).toBeTrue();
		expect(result.relationKindsAccepted).toEqual(["blocked_by"]);
		expect(result.archiveVerbAccepted).toBeTrue();
		expect(result.stateWriteAccepted).toBeTrue();
		expect(fake.projects.size).toBe(0);
	});
});

describe("replication reports", () => {
	test("renders snapshot counts and emits ApplyResult verbatim in JSON mode", () => {
		const snapshot = sampleSnapshot();
		const summary = formatSnapshotSummary(snapshot);
		expect(summary).toContain("Items       5");
		expect(summary).toContain("2 gap(s): 2, 4");
		expect(summary).toContain(snapshot.digest.slice(0, 12));

		const probe = {
			dialect: "issues" as const,
			identifierAvailable: true,
			existingProjectId: null,
			memberByEmail: {},
			sequencesMaxEver: true,
			createdAtAccepted: true,
			createdByAccepted: false,
			commentCreatedAtAccepted: true,
			commentCreatedByAccepted: false,
			relationKindsAccepted: ["blocked_by"],
			archiveVerbAccepted: true,
			stateWriteAccepted: true,
		};
		const result = {
			mode: "exact" as const,
			dryRun: false,
			projectId: "project",
			itemsCreated: 5,
			itemsSkipped: 0,
			placeholdersCreated: 2,
			placeholdersDeleted: 2,
			parentsSet: 1,
			relationsCreated: 1,
			commentsCreated: 2,
			archivedCount: 1,
			manifests: { degradations: [], losses: [], warnings: [] },
			complete: true,
			probe,
		};
		expect(JSON.parse(formatApplyReport(result, { json: true }))).toEqual(result);
		expect(formatApplyReport(result, { json: false })).toContain("Replication complete");
	});
});
