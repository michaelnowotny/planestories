import chalk from "chalk";
import type { ResolvedConfig } from "../types.ts";

/**
 * State the resolved target before doing any work.
 *
 * The failure this prevents: running a command WITHOUT `--context ce` silently
 * targets the other instance, and the symptom is not "wrong server" — it is a
 * cascade of bogus "parent not found" errors, because the file's ids do not
 * exist there. That reads like a broken file, and it cost the finance session
 * about two hours before `--dry-run --check` happened to surface a workspace
 * slug inside a 403 message. One line, before anything happens, makes it
 * self-diagnosing.
 *
 * Goes to STDERR so `--json` stdout stays machine-clean.
 */
export function announceTarget(
	config: ResolvedConfig,
	context: string | undefined,
	project?: string,
): void {
	const host = config.baseUrl ? config.baseUrl.replace(/^https?:\/\//, "") : "(no base url)";
	// Prefer the context ACTUALLY in force. With `defaultContext` or a
	// single-context config it is selected implicitly, so the command line the
	// user typed no longer answers "which installation is this?" — which is the
	// whole question this line exists to answer.
	const where = context
		? `--context ${context}`
		: config.contextName
			? `context ${config.contextName} (implicit)`
			: "default (bare PLANE_* env)";
	const proj = project ?? config.defaultProject;
	console.error(
		chalk.dim(
			`→ ${host} · workspace ${config.workspaceSlug} · ${proj ? `project ${proj} · ` : ""}${where}`,
		),
	);
}
