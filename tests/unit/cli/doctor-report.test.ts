import { expect, test } from "bun:test";
import { assembleDoctorReport } from "../../../src/cli/commands/doctor.ts";

test("doctor report omits houseRules by default and adds its findings only when enabled", () => {
	const base = { project: "DATA", findings: 2, existing: true };
	expect(assembleDoctorReport(base)).toEqual(base);
	expect(
		assembleDoctorReport(base, {
			missingEffort: [{ identifier: "DATA-1", title: "One" }],
			proseDepsWithoutRelation: [],
		}),
	).toEqual({
		...base,
		findings: 3,
		houseRules: {
			missingEffort: [{ identifier: "DATA-1", title: "One" }],
			proseDepsWithoutRelation: [],
		},
	});
});

test("a snapshot-sourced report carries its provenance IN the JSON payload", () => {
	// --json prints nothing to stdout but the payload, and announceSnapshotSource is
	// silent in json mode — so without this field a stored CI artifact is
	// indistinguishable from a live reading.
	const base = { project: "DATA", findings: 0 } as Record<string, unknown> & { findings: number };
	const withSource = assembleDoctorReport(
		{ ...base, source: { kind: "snapshot", takenAt: "2026-08-17T05:20:43.536Z" } },
		undefined,
	);
	expect(withSource.source).toEqual({ kind: "snapshot", takenAt: "2026-08-17T05:20:43.536Z" });
	// A live run must NOT carry it, or "live" becomes unfalsifiable.
	expect(assembleDoctorReport(base, undefined).source).toBeUndefined();
});
