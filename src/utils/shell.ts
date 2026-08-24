/**
 * POSIX single-quote a value for a command we tell the operator to RUN.
 *
 * Every refusal in this codebase names the command that would answer it, and
 * those commands carry board data — project names with spaces, apostrophes,
 * `$`, backticks. A refusal that produces an unrunnable or, worse, a
 * differently-runnable command is a refusal that lies.
 *
 * Single quotes disable every shell expansion, so the only character needing
 * care is `'` itself: close the quote, emit an escaped quote, reopen.
 *
 * This lived as three byte-identical private copies (`cli/commands/query.ts`,
 * `sync/query.ts`, `sync/graph_queries.ts`). Quoting is exactly the kind of
 * thing that gets fixed in one copy and not the others.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
