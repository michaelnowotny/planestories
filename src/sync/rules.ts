import type { ParsedFile } from "../types.ts";

interface PlaneIdDeclaration {
	filePath: string;
	title: string;
}

export interface DuplicatePlaneId {
	planeId: string;
	declarations: PlaneIdDeclaration[];
}

/** Refusal raised before an import can direct two stories at one board item. */
export class DuplicatePlaneIdError extends Error {
	constructor(readonly duplicates: DuplicatePlaneId[]) {
		const detail = duplicates
			.map(
				({ planeId, declarations }) =>
					`${JSON.stringify(planeId)} is declared by ${declarations
						.map(({ filePath, title }) => `${JSON.stringify(title)} (${filePath})`)
						.join(" and ")}`,
			)
			.join("; ");
		super(
			`Duplicate plane_id pre-flight failed: ${detail}. Refusing the entire import before any board write. ` +
				"Edit the named YAML blocks so every story has a unique plane_id (or clear the incorrect plane_id), then re-run import.",
		);
		this.name = "DuplicatePlaneIdError";
	}
}

/** Every non-blank Plane UUID may identify at most one story in the import fileset. */
export function assertUniquePlaneIds(files: readonly ParsedFile[]): void {
	const byPlaneId = new Map<string, PlaneIdDeclaration[]>();
	for (const file of files) {
		for (const story of file.stories) {
			const planeId = story.planeId?.trim();
			if (!planeId) continue;
			const declarations = byPlaneId.get(planeId) ?? [];
			declarations.push({ filePath: file.filePath, title: story.title });
			byPlaneId.set(planeId, declarations);
		}
	}

	const duplicates = [...byPlaneId.entries()]
		.filter(([, declarations]) => declarations.length > 1)
		.map(([planeId, declarations]) => ({ planeId, declarations }));
	if (duplicates.length > 0) throw new DuplicatePlaneIdError(duplicates);
}
