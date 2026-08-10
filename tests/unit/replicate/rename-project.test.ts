import { describe, expect, test } from "bun:test";
import { renameProject } from "../../../src/cli/commands/rename-project.ts";
import { FakePlane } from "./fake-plane.ts";

describe("rename-project", () => {
	test("dry-run resolves case-insensitive identifier without writing", async () => {
		const fake = new FakePlane();
		await fake.createProject({ name: "Data Project", identifier: "DATA" });
		const before = fake.writeCalls;
		const result = await renameProject(fake, {
			project: "data",
			name: "New Data",
			yes: false,
		});
		expect(result.dryRun).toBeTrue();
		expect(fake.writeCalls).toBe(before);
		expect(fake.projectByIdentifier("DATA")?.name).toBe("Data Project");
	});

	test("--yes patches one project", async () => {
		const fake = new FakePlane();
		await fake.createProject({ name: "Data Project", identifier: "DATA" });
		const result = await renameProject(fake, {
			project: "Data Project",
			name: "New Data",
			identifier: "NEXT",
			yes: true,
		});
		expect(result.identifierChanged).toBeTrue();
		expect(fake.projectByIdentifier("NEXT")?.name).toBe("New Data");
	});

	test("missing rename flags and identifier collisions surface clearly", async () => {
		const fake = new FakePlane();
		await fake.createProject({ name: "Data", identifier: "DATA" });
		await fake.createProject({ name: "Other", identifier: "OTHER" });
		await expect(renameProject(fake, { project: "DATA", yes: false })).rejects.toThrow(
			/at least one/,
		);
		await expect(
			renameProject(fake, { project: "DATA", identifier: "OTHER", yes: true }),
		).rejects.toThrow(/already in use/);
	});
});
