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
	// A file that will not PARSE is a lint finding, not a crash.
	//
	// `lint` is the offline structural checker and a CI gate: its whole job is to
	// report every problem with a file attached. Letting a ParseError escape gave
	// a bare message with no file, and stopped at the first bad file instead of
	// reporting the rest — so a run over twenty files told you about one of them
	// and exited zero.
	const unparseable: LintFinding[] = [];
	const parsedFiles = (
		await Promise.all(
			files.map(async (filePath) => {
				try {
					return parseMarkdownFile(await Bun.file(filePath).text(), filePath);
				} catch (error) {
					unparseable.push({
						filePath,
						story: null,
						severity: "error",
						rule: "unparseable-file",
						message: error instanceof Error ? error.message : String(error),
					});
					return null;
				}
			}),
		)
	).filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);
	const stories: LintStory[] = parsedFiles.flatMap((parsed) =>
		parsed.stories.map((story) => ({ filePath: parsed.filePath, story })),
	);
	let findings = [...unparseable, ...runLintRules(stories)];
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
