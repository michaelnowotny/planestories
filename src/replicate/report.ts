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
		activityLine(snapshot),
		`Digest      ${digest.slice(0, 12)}`,
	].join("\n");
}

/**
 * Report activity coverage on EVERY snapshot, not only captured ones. "Not
 * captured" is precisely the fact an operator archiving a source instance needs
 * to see before they retire it, and a line that appears only on success is the
 * line nobody misses at the moment it matters.
 */
function activityLine(snapshot: ProjectSnapshot): string {
	if (snapshot.activities === undefined) {
		return "Activity    not captured (pass --with-activity to archive the audit trail)";
	}
	const entries = Object.values(snapshot.activities).reduce(
		(sum, values) => sum + values.length,
		0,
	);
	const withHistory = Object.keys(snapshot.activities).length;
	// Say "captured", and report coverage against items SCANNED. The bare
	// "N entries across M item(s)" read as "we only looked at M" whenever some
	// items came back empty — understating coverage as badly as overstating it.
	return `Activity    captured: ${entries} entries; ${withHistory}/${snapshot.items.length} items had history`;
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
