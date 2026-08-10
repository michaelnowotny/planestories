import type { ApplyResult } from "./apply.ts";
import { computeSnapshotDigest } from "./snapshot.ts";
import type { ProjectSnapshot } from "./types.ts";

export function formatApplyReport(result: ApplyResult, options: { json: boolean }): string {
	if (options.json) return JSON.stringify(result, null, 2);
	const probe = result.probe;
	const lines = [
		`Replication ${result.dryRun ? "dry-run" : result.complete ? "complete" : "paused"}`,
		`Mode                 ${result.mode}`,
		`Project              ${result.projectId ?? "(not created)"}`,
		`Items                ${result.itemsCreated} created, ${result.itemsSkipped} resumed/skipped`,
		`Placeholders         ${result.placeholdersCreated} created, ${result.placeholdersDeleted} deleted`,
		`Parents              ${result.parentsSet}`,
		`Relations            ${result.relationsCreated}`,
		`Comments             ${result.commentsCreated}`,
		`Archived             ${result.archivedCount}`,
		"",
		"Probe",
		`  dialect            ${probe.dialect}`,
		`  max-ever sequence   ${verdict(probe.sequencesMaxEver)}`,
		`  item created_at     ${verdict(probe.createdAtAccepted)}`,
		`  item created_by     ${verdict(probe.createdByAccepted)}`,
		`  comment created_at  ${verdict(probe.commentCreatedAtAccepted)}`,
		`  comment created_by  ${verdict(probe.commentCreatedByAccepted)}`,
		`  archive verb        ${verdict(probe.archiveVerbAccepted)}`,
		`  state writes        ${verdict(probe.stateWriteAccepted)}`,
		`  relation kinds      ${
			probe.relationKindsAccepted === null
				? "not probed"
				: probe.relationKindsAccepted.join(", ") || "none accepted"
		}`,
	];
	appendManifest(lines, "Degradations", result.manifests.degradations);
	appendManifest(lines, "Losses", result.manifests.losses);
	if (result.manifests.warnings.length > 0) {
		lines.push("", "Warnings", ...result.manifests.warnings.map((warning) => `  - ${warning}`));
	}
	return lines.join("\n");
}

export function formatSnapshotSummary(snapshot: ProjectSnapshot): string {
	const comments = Object.values(snapshot.comments).reduce((sum, values) => sum + values.length, 0);
	const relations = Object.values(snapshot.relations).reduce(
		(sum, byKind) => sum + Object.values(byKind).reduce((inner, ids) => inner + ids.length, 0),
		0,
	);
	const digest = snapshot.digest || computeSnapshotDigest(snapshot);
	return [
		`Snapshot ${snapshot.project.identifier} — ${snapshot.project.name}`,
		`Items       ${snapshot.items.length} (${snapshot.items.filter((item) => item.archived).length} archived)`,
		`Sequence    1..${snapshot.sequence.max}, ${snapshot.sequence.gaps.length} gap(s)${snapshot.sequence.gaps.length ? `: ${snapshot.sequence.gaps.join(", ")}` : ""}`,
		`States      ${snapshot.states.length}`,
		`Labels      ${snapshot.labels.length}`,
		`Comments    ${comments}`,
		`Relations   ${relations} directed snapshot reference(s)`,
		`Digest      ${digest.slice(0, 12)}`,
	].join("\n");
}

function verdict(value: boolean | null): string {
	return value === null ? "deferred" : value ? "accepted" : "rejected";
}

function appendManifest(
	lines: string[],
	title: string,
	entries: Array<{ feature: string; detail: string; count: number }>,
): void {
	if (entries.length === 0) return;
	lines.push("", title);
	for (const entry of entries) {
		lines.push(`  - ${entry.feature} (${entry.count}): ${entry.detail}`);
	}
}
