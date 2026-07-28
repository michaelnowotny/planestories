import chalk from "chalk";
import type { Command } from "commander";
import { loadRepoConfig } from "../../config/repo_config.ts";
import { ConfigError, ParseError } from "../../errors.ts";
import { type LintReport, lintFiles } from "../../lint/linter.ts";
import type { LintFinding } from "../../lint/rules.ts";

function handleError(error: unknown): never {
	if (error instanceof ConfigError || error instanceof ParseError) {
		console.error(chalk.red(`${error.name}: ${error.message}`));
	} else if (error instanceof Error) {
		console.error(chalk.red(`Error: ${error.message}`));
	} else {
		console.error(chalk.red(`Error: ${String(error)}`));
	}
	process.exit(1);
}

function storyLabel(finding: LintFinding): string {
	return finding.story.planeIdentifier
		? `${finding.story.title} / ${finding.story.planeIdentifier}`
		: finding.story.title;
}

export function printLintReport(report: LintReport): void {
	console.log("");
	for (const filePath of report.files) {
		console.log(chalk.bold(`Lint ${filePath}`));
		const findings = report.findings.filter((finding) => finding.filePath === filePath);
		if (findings.length === 0) {
			console.log(chalk.green("  Clean — no convention violations found."));
			continue;
		}
		for (const finding of findings) {
			const line = `  ${finding.severity.toUpperCase()} ${finding.rule}: ${storyLabel(finding)} — ${finding.message}`;
			console.log(finding.severity === "error" ? chalk.red(line) : chalk.yellow(line));
		}
	}
	const errorLabel = report.errors === 1 ? "error" : "errors";
	const warningLabel = report.warnings === 1 ? "warning" : "warnings";
	const fileLabel = report.files.length === 1 ? "file" : "files";
	console.log(
		`  ${report.errors} ${errorLabel}, ${report.warnings} ${warningLabel} across ${report.files.length} ${fileLabel}.`,
	);
}

export function registerLintCommand(program: Command): void {
	program
		.command("lint")
		.description(
			"Offline structural and convention checks (strict by default; use --warn-only to downgrade). Reads .planestories.yml for repo lint conventions.",
		)
		.argument("<files...>", "Markdown story file paths")
		.option("--warn-only", "Downgrade all violations to warnings and always exit 0", false)
		.action(async (files: string[], options) => {
			try {
				// Repo conventions (.planestories.yml, discovered upward). The --warn-only
				// flag always wins; otherwise `lint.strictness: warn` sets warn mode.
				const repo = await loadRepoConfig();
				const warnOnly = Boolean(options.warnOnly) || repo.lint?.strictness === "warn";
				const disabledRules = repo.lint?.disable;
				if (disabledRules && disabledRules.length > 0) {
					// Never silently drop coverage — say which rules the repo disabled.
					console.log(chalk.dim(`  (.planestories.yml disables: ${disabledRules.join(", ")})`));
				}
				const report = await lintFiles(files, { warnOnly, disabledRules });
				printLintReport(report);
				if (report.exitCode !== 0) {
					process.exit(1);
				}
			} catch (error) {
				handleError(error);
			}
		});
}
