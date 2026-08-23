import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportStories } from "../../../src/sync/exporter.ts";
import { importStories } from "../../../src/sync/importer.ts";
import type { ResolvedConfig } from "../../../src/types.ts";
import { type FakeData, makeFakeClient } from "../../helpers/fake-plane-client.ts";

const PROJECT = "project-1";
const A = "issue-a";
const B = "issue-b";
const C = "issue-c";

const config: ResolvedConfig = {
	apiKey: "test",
	workspaceSlug: "ws",
	baseUrl: "https://api.plane.so",
	defaultProject: "Relations",
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 0,
};

function item(id: string, sequence: number, externalSource = "planestories") {
	return {
		id,
		sequence_id: sequence,
		name: `Story ${sequence}`,
		priority: "none",
		assignees: [],
		labels: [],
		external_source: externalSource,
	};
}

function fakeData(extra: Partial<FakeData> = {}): FakeData {
	return {
		projects: [{ id: PROJECT, name: "Relations", identifier: "ENG" }],
		workItems: { [PROJECT]: [item(A, 1), item(B, 2), item(C, 3)] },
		...extra,
	};
}

function story(title: string, id: string, identifier: string, fields = ""): string {
	return `## ${title}

\`\`\`yaml
plane_id: ${id}
plane_identifier: ${identifier}
${fields}
\`\`\`

Body.
`;
}

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "relation-sync-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
	const path = join(directory, name);
	writeFileSync(path, `---\nproject: Relations\n---\n\n${contents}`);
	return path;
}

describe("global relation reconciliation", () => {
	test("waits until every new story exists before resolving relation identifiers", async () => {
		const file = write(
			"new.md",
			`## New A

Body.

## New B

\`\`\`yaml
blocked_by: [ENG-101]
\`\`\`

Body.
`,
		);
		const fake = makeFakeClient(
			fakeData({
				workItems: { [PROJECT]: [] },
			}),
		);
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			noWriteBack: true,
		});
		expect(summary.created).toBe(2);
		expect(summary.relationsCreated).toBe(1);
		expect(fake.createdRelations[0]).toMatchObject({
			workItemId: "wi-102",
			relationType: "blocked_by",
			issues: ["wi-101"],
		});
	});

	test("export to import round-trip is unchanged with zero relation writes", async () => {
		const fake = makeFakeClient(
			fakeData({
				workItems: { [PROJECT]: [item(A, 1), item(B, 2)] },
				relations: { [A]: { blocked_by: [B] } },
			}),
		);
		const file = join(directory, "export.md");
		await exportStories(fake.client, { config, filters: {}, outputPath: file });
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			noWriteBack: true,
		});

		expect(summary.unchanged).toBe(2);
		expect(fake.updatedItems).toHaveLength(0);
		expect(fake.createdRelations).toHaveLength(0);
		expect(fake.removedRelations).toHaveLength(0);
	});

	test("deduplicates mirrored declarations, auto-mirrors, and reruns idempotently", async () => {
		const fileA = write("a.md", story("A", A, "ENG-1", "blocked_by: [ENG-2]"));
		const fileB = write("b.md", story("B", B, "ENG-2", "blocks: [ENG-1]"));
		const fake = makeFakeClient(fakeData());

		const first = await importStories(fake.client, {
			files: [fileA, fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(first.relationsCreated).toBe(1);
		expect(fake.createdRelations).toHaveLength(1);
		expect(fake.createdRelations[0]).toMatchObject({
			workItemId: A,
			relationType: "blocked_by",
			issues: [B],
		});
		expect((await fake.client.getRelations(PROJECT, A)).blocked_by).toEqual([B]);
		expect((await fake.client.getRelations(PROJECT, B)).blocking).toEqual([A]);

		const second = await importStories(fake.client, {
			files: [fileA, fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(second.relationsCreated).toBe(0);
		expect(second.relationsRemoved).toBe(0);
		expect(fake.createdRelations).toHaveLength(1);
	});

	test("normalizes relation seeds and auto-mirrors their opposite side", async () => {
		const fake = makeFakeClient(
			fakeData({
				relations: {
					[A]: { blocked_by: [B, B], relates_to: [C] },
				},
			}),
		);

		expect((await fake.client.getRelations(PROJECT, A)).blocked_by).toEqual([B]);
		expect((await fake.client.getRelations(PROJECT, B)).blocking).toEqual([A]);
		expect((await fake.client.getRelations(PROJECT, C)).relates_to).toEqual([A]);
	});

	test("creates relates_to once and the fake mirrors it symmetrically", async () => {
		const file = write("relates.md", story("A", A, "ENG-1", "relates_to: [ENG-2]"));
		const fake = makeFakeClient(fakeData());
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationsCreated).toBe(1);
		expect(fake.createdRelations).toHaveLength(1);
		expect((await fake.client.getRelations(PROJECT, A)).relates_to).toEqual([B]);
		expect((await fake.client.getRelations(PROJECT, B)).relates_to).toEqual([A]);
	});

	test("keeps an omitted relation on a subset import and removes it when both endpoints import", async () => {
		const fileAWithDependency = write(
			"a-with-dependency.md",
			story("A", A, "ENG-1", "blocked_by: [ENG-2]"),
		);
		const fileAWithoutDependency = write("a-without-dependency.md", story("A", A, "ENG-1"));
		const fileB = write("b.md", story("B", B, "ENG-2"));
		const managed = makeFakeClient(fakeData());

		const initial = await importStories(managed.client, {
			files: [fileAWithDependency, fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(initial.relationsCreated).toBe(1);

		const subset = await importStories(managed.client, {
			files: [fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(subset.relationsRemoved).toBe(0);
		expect(managed.removedRelations).toHaveLength(0);
		expect((await managed.client.getRelations(PROJECT, A)).blocked_by).toEqual([B]);

		const full = await importStories(managed.client, {
			files: [fileAWithoutDependency, fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(full.relationsRemoved).toBe(1);
		expect(managed.removedRelations).toHaveLength(1);
		expect((await managed.client.getRelations(PROJECT, A)).blocked_by).toEqual([]);
	});

	test("preserves a relation with a non-planestories endpoint", async () => {
		const fileA = write("a.md", story("A", A, "ENG-1"));
		const fileB = write("b.md", story("B", B, "ENG-2"));
		const humanData = fakeData({
			workItems: { [PROJECT]: [item(A, 1), item(B, 2, "")] },
			relations: { [A]: { blocked_by: [B] } },
		});
		const human = makeFakeClient(humanData);
		const preserved = await importStories(human.client, {
			files: [fileA, fileB],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(preserved.relationsRemoved).toBe(0);
		expect(human.removedRelations).toHaveLength(0);
	});

	test("resolves a board-only target and warns for a missing target", async () => {
		const file = write("cross-file.md", story("A", A, "ENG-1", "blocks: [ENG-2, ENG-404]"));
		const fake = makeFakeClient(fakeData());
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationsCreated).toBe(1);
		expect(summary.relationWarnings.join(" ")).toContain("ENG-404");
		expect(fake.createdRelations[0]).toMatchObject({
			workItemId: A,
			relationType: "blocking",
			issues: [B],
		});
	});

	test("refuses a dependency cycle before any relation write", async () => {
		const file = write(
			"cycle.md",
			`${story("A", A, "ENG-1", "blocks: [ENG-2]")}
${story("B", B, "ENG-2", "blocks: [ENG-1]")}`,
		);
		const fake = makeFakeClient(fakeData());
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationErrors.join(" ")).toContain("ENG-1 -> ENG-2 -> ENG-1");
		expect(fake.createdRelations).toHaveLength(0);
		expect(fake.removedRelations).toHaveLength(0);
	});

	test("detects a cycle closed by a preserved non-removable board edge", async () => {
		const file = write(
			"preserved-cycle.md",
			`${story("A", A, "ENG-1", "blocks: [ENG-2]")}
${story("B", B, "ENG-2")}
${story("C", C, "ENG-3")}`,
		);
		const fake = makeFakeClient(
			fakeData({
				workItems: {
					[PROJECT]: [item(A, 1), item(B, 2, ""), item(C, 3)],
				},
				relations: { [B]: { blocking: [A] } },
			}),
		);
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});

		expect(summary.relationErrors.join(" ")).toContain("ENG-1 -> ENG-2 -> ENG-1");
		expect(fake.createdRelations).toHaveLength(0);
		expect(fake.removedRelations).toHaveLength(0);
		expect(summary.results.find((result) => result.planeId === A)?.planeHash).toBeUndefined();
		expect(summary.results.find((result) => result.planeId === B)?.planeHash).toBeUndefined();
		expect(summary.results.find((result) => result.planeId === C)?.planeHash).toBeString();
	});

	test("detects a cycle through relations fetched from a cross-file target", async () => {
		const file = write("cross-file-cycle.md", story("A", A, "ENG-1", "blocks: [ENG-2]"));
		const fake = makeFakeClient(
			fakeData({
				relations: {
					[B]: { blocking: [C] },
					[C]: { blocking: [A] },
				},
			}),
		);
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});

		expect(summary.relationErrors.join(" ")).toContain("ENG-1 -> ENG-2 -> ENG-3 -> ENG-1");
		expect(fake.createdRelations).toHaveLength(0);
	});

	test("reports a stripped self-reference as a warning without starving a sibling edge", async () => {
		const file = write(
			"self.md",
			`${story("A", A, "ENG-1", "blocks: [ENG-1]")}
${story("B", B, "ENG-2", "blocked_by: [ENG-3]")}`,
		);
		const fake = makeFakeClient(fakeData());
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationWarnings.join(" ")).toContain("cannot reference itself");
		expect(summary.relationErrors).toEqual([]);
		expect(summary.relationsCreated).toBe(1);
		expect(fake.createdRelations[0]).toMatchObject({
			workItemId: B,
			relationType: "blocked_by",
			issues: [C],
		});
		expect(summary.results.every((result) => result.planeHash !== undefined)).toBe(true);
	});

	test("dry-run reports creates, removals, dangling references, and cycles without writes", async () => {
		const file = write(
			"dry.md",
			`${story("A", A, "ENG-1", "blocks: [ENG-2, ENG-404]")}
${story("B", B, "ENG-2", "blocks: [ENG-1]")}
${story("C", C, "ENG-3")}`,
		);
		const fake = makeFakeClient(fakeData({ relations: { [A]: { relates_to: [C] } } }));
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			dryRun: true,
			force: true,
			noWriteBack: true,
		});
		// Selective apply: the cyclic A<->B block edges are skipped and reported, the
		// dangling ENG-404 warns, but the non-cyclic work still proceeds — here the stale
		// A relates_to C is proposed for removal. Dry-run reports it and writes nothing;
		// apply would report the same, so counts never diverge.
		expect(summary.relationErrors.join(" ")).toContain("dependency cycle");
		expect(summary.relationWarnings.join(" ")).toContain("ENG-404");
		expect(summary.relationsCreated).toBe(0);
		expect(summary.relationsRemoved).toBe(1);
		expect(summary.relationChanges).toHaveLength(1);
		expect(fake.createdItems).toHaveLength(0);
		expect(fake.updatedItems).toHaveLength(0);
		expect(fake.createdRelations).toHaveLength(0);
		expect(fake.removedRelations).toHaveLength(0);
	});

	test("dry-run reports proposed create/remove changes when the graph is valid", async () => {
		const file = write(
			"dry-valid.md",
			`${story("A", A, "ENG-1", "blocked_by: [ENG-2]")}
${story("C", C, "ENG-3")}`,
		);
		const fake = makeFakeClient(fakeData({ relations: { [A]: { relates_to: [C] } } }));
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			dryRun: true,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationsCreated).toBe(1);
		expect(summary.relationsRemoved).toBe(1);
		expect(summary.relationChanges).toHaveLength(1);
		expect(fake.createdRelations).toHaveLength(0);
		expect(fake.removedRelations).toHaveLength(0);
	});

	test("dry-run resolves a declared identifier belonging to another new batch story", async () => {
		const file = write(
			"dry-batch.md",
			`## New A

\`\`\`yaml
plane_identifier: ENG-101
blocks: [ENG-102]
\`\`\`

Body.

## New B

\`\`\`yaml
plane_identifier: " eng-102 "
\`\`\`

Body.
`,
		);
		const fake = makeFakeClient(fakeData({ workItems: { [PROJECT]: [] } }));
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			dryRun: true,
			noWriteBack: true,
		});

		expect(summary.relationsCreated).toBe(1);
		expect(summary.relationWarnings).toEqual([]);
		expect(summary.relationChanges).toEqual([
			{
				identifier: "ENG-102",
				created: ["blocked_by ENG-101"],
				removed: [],
			},
		]);
		expect(fake.createdItems).toHaveLength(0);
		expect(fake.createdRelations).toHaveLength(0);
	});

	test("selective apply: a cycle skips only its own edges; unrelated valid relations still sync", async () => {
		// A<->B form the cycle (both block edges skipped + reported). C blocked_by A is
		// NOT part of the cycle, so it IS created, and C keeps its warm hash; only the
		// cyclic stories A and B have their relation hash withheld.
		const file = write(
			"cycle-hash.md",
			`${story("A", A, "ENG-1", "blocks: [ENG-2]")}
${story("B", B, "ENG-2", "blocks: [ENG-1]")}
${story("C", C, "ENG-3", "blocked_by: [ENG-1]")}`,
		);
		const fake = makeFakeClient(fakeData());
		const summary = await importStories(fake.client, {
			files: [file],
			config,
			force: true,
			noWriteBack: true,
		});
		expect(summary.relationErrors.join(" ")).toContain("dependency cycle");
		// The cyclic A<->B edges are not written; C's valid blocked_by A edge is.
		expect(fake.createdRelations).toHaveLength(1);
		expect(fake.createdRelations[0]).toMatchObject({ workItemId: C, relationType: "blocked_by" });
		const cResult = summary.results.find((result) => result.planeId === C);
		expect(cResult?.planeHash).not.toBeUndefined();
		for (const cyclic of [A, B]) {
			expect(summary.results.find((r) => r.planeId === cyclic)?.planeHash).toBeUndefined();
		}
	});
});

describe("Plane CE: relation removal is unavailable", () => {
	// CE exposes relation create and list but NOT remove — `/relations/remove/`
	// 404s (verified on 1.4.1). Reported by the research session after deleting five
	// `blocked_by` edges from story files and finding the board kept them.
	//
	// The defect was not the 404, which is a real deployment limit, but what it did
	// to the run: removals apply BEFORE creates, and a single throw escaped the
	// whole reconciliation phase. So one un-removable edge also skipped every
	// CREATE, and the importer's blanket catch withheld `plane_hash` for every
	// story — making the next identical run fail identically, forever.
	async function ceRun(files: string[]) {
		const fake = makeFakeClient(fakeData({ relationRemovalUnsupported: true }));
		// Establish A blocked_by B on the board, with both endpoints managed.
		const seedA = write("seed-a.md", story("A", A, "ENG-1", "blocked_by: [ENG-2]"));
		const seedB = write("seed-b.md", story("B", B, "ENG-2"));
		await importStories(fake.client, {
			files: [seedA, seedB],
			config,
			force: true,
			noWriteBack: true,
		});
		fake.createdRelations.length = 0;
		const summary = await importStories(fake.client, { files, config, force: true });
		return { fake, summary };
	}

	test("an un-removable edge does not block the creates in the same run", async () => {
		// A drops its edge to B (must be removed → 404) and gains one to C (create).
		const fileA = write("a.md", story("A", A, "ENG-1", "blocked_by: [ENG-3]"));
		const fileB = write("b.md", story("B", B, "ENG-2"));
		const fileC = write("c.md", story("C", C, "ENG-3"));
		const { fake, summary } = await ceRun([fileA, fileB, fileC]);

		// The removal failed and is REPORTED, naming the deployment limitation...
		expect(summary.relationErrors.join(" ")).toMatch(/does not support relation REMOVAL/);
		// ...and the create still landed instead of being skipped by the throw.
		expect(fake.createdRelations.length).toBeGreaterThan(0);
	});

	test("the divergent story does not get a warm hash", async () => {
		// A drops its edge to B; the removal 404s, so file and board now disagree.
		// If A were hashed as synced, a later run would skip it and the divergence
		// would become permanent and invisible.
		const fileA = write("a2.md", story("A", A, "ENG-1"));
		const fileB = write("b2.md", story("B", B, "ENG-2"));
		const { summary } = await ceRun([fileA, fileB]);

		expect(summary.relationErrors.length).toBeGreaterThan(0);
		expect(summary.results.find((r) => r.planeId === A)?.planeHash).toBeUndefined();
	});
});
