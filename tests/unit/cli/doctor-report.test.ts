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
