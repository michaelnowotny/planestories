import { describe, expect, test } from "bun:test";
import { formatSnapshotSummary } from "../../../src/replicate/report.ts";
import { sampleSnapshot } from "./fixtures.ts";

/**
 * The snapshot summary is what an operator reads before deciding a source
 * instance is safe to retire, so its activity line must be legible in BOTH
 * directions — and neither over- nor under-state coverage.
 */
describe("snapshot summary — activity line", () => {
	test("a legacy/uncaptured snapshot says so, and names the flag", () => {
		// There was previously no test that the uncaptured wording is ever printed,
		// so deleting the branch would have gone unnoticed — and this is the case an
		// operator most needs to see before archiving.
		const line = formatSnapshotSummary(sampleSnapshot())
			.split("\n")
			.find((l) => l.startsWith("Activity"));
		expect(line).toContain("not captured");
		expect(line).toContain("--with-activity");
	});

	test("a captured snapshot says 'captured' and reports coverage against items SCANNED", () => {
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
			],
		};
		const line = formatSnapshotSummary(snapshot)
			.split("\n")
			.find((l) => l.startsWith("Activity"));

		expect(line).toContain("captured");
		// The denominator must be items SCANNED, not items that happened to have
		// history. The old "N entries across 1 item(s)" wording read as "we only
		// looked at one" on a board of five — understating coverage as badly as
		// overstating it would.
		expect(line).toContain(`1/${snapshot.items.length} items had history`);
	});
});
