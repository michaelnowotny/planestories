import { expect, spyOn, test } from "bun:test";
import { printDryRun } from "../../../src/cli/commands/import.ts";
import type { ImportSummary, UserStory } from "../../../src/types.ts";

const story = (title: string): UserStory => ({
	title,
	planeId: "item-1",
	planeIdentifier: "ENG-1",
	planeUrl: null,
	planeHash: "old",
	priority: null,
	labels: [],
	estimate: null,
	effortDays: null,
	assignee: null,
	status: null,
	body: "Body",
	project: "Engineering",
	parent: null,
	blockedBy: [],
	blocks: [],
	relatesTo: [],
	kind: "story",
	comment: null,
});

const baseSummary = (results: ImportSummary["results"]): ImportSummary => ({
	total: results.length,
	created: 0,
	updated: 0,
	failed: 0,
	skipped: results.length,
	unchanged: 0,
	results,
	labelsCreated: [],
	labelsSkipped: [],
	structureWarnings: [],
	relationsCreated: 0,
	relationsRemoved: 0,
	relationWarnings: [],
	relationErrors: [],
	relationChanges: [],
});

test("dry-run renderer prints every diff form and suppresses absent diffs", () => {
	const log = spyOn(console, "log").mockImplementation(() => {});
	printDryRun(
		baseSummary([
			{
				story: story("Changed"),
				action: "skipped",
				wouldAction: "update",
				diff: {
					changes: [
						{ field: "title", from: "Old", to: "Changed" },
						{ field: "labels", from: null, to: "+Feature -Old" },
						{ field: "description", from: null, to: null },
					],
					descriptionDiffers: true,
					descriptionPreview: "- before\n+ after",
					hashOnly: false,
				},
			},
			{
				story: story("Hash"),
				action: "skipped",
				wouldAction: "update",
				diff: { changes: [], descriptionDiffers: false, hashOnly: true },
			},
			{
				story: story("Unavailable"),
				action: "skipped",
				wouldAction: "update",
				diffUnavailable: "item not in index",
			},
			{ story: story("No diff"), action: "skipped", wouldAction: "update" },
		]),
		false,
	);
	const output = log.mock.calls.map((call) => String(call[0])).join("\n");
	expect(output).toContain('title: "Old" -> "Changed"');
	expect(output).toContain("labels: +Feature -Old");
	expect(output).toContain("description: differs (canonical text)");
	expect(output).toContain("- before\n      + after");
	expect(output).toContain("hash mismatch only");
	expect(output).toContain("diff unavailable (item not in index)");
	expect(output).toContain("would update: No diff");
	const noDiffSection = output.slice(output.indexOf("would update: No diff"));
	expect(noDiffSection).not.toContain("title:");
	expect(noDiffSection).not.toContain("hash mismatch only");
	log.mockRestore();
});
