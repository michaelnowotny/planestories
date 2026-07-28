import { parseMarkdownFile } from "../markdown/parser.ts";
import { type LintFinding, type LintRule, type LintStory, runLintRules } from "./rules.ts";

export interface LintOptions {
	warnOnly?: boolean;
	/** Rule names to skip (from `.planestories.yml` `lint.disable`). */
	disabledRules?: readonly LintRule[];
}

export interface LintReport {
	files: string[];
	findings: LintFinding[];
	errors: number;
	warnings: number;
	exitCode: 0 | 1;
}

/** Parse all files, then lint their stories as one cross-file-aware set. */
export async function lintFiles(
	files: readonly string[],
	options: LintOptions = {},
): Promise<LintReport> {
	const parsedFiles = await Promise.all(
		files.map(async (filePath) => parseMarkdownFile(await Bun.file(filePath).text(), filePath)),
	);
	const stories: LintStory[] = parsedFiles.flatMap((parsed) =>
		parsed.stories.map((story) => ({ filePath: parsed.filePath, story })),
	);
	let findings = runLintRules(stories);
	if (options.disabledRules && options.disabledRules.length > 0) {
		const disabled = new Set(options.disabledRules);
		findings = findings.filter((finding) => !disabled.has(finding.rule));
	}
	if (options.warnOnly) {
		findings = findings.map((finding) => ({ ...finding, severity: "warning" }));
	}
	const errors = findings.filter((finding) => finding.severity === "error").length;
	const warnings = findings.length - errors;

	return {
		files: [...files],
		findings,
		errors,
		warnings,
		exitCode: errors > 0 ? 1 : 0,
	};
}
