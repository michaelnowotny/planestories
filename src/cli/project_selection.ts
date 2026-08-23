import type { Command } from "commander";

/**
 * Which board-selection routes a specific command actually registers.
 *
 * Read from commander rather than declared by hand: the refusal that offers
 * these routes must not be able to drift from the surface that accepts them.
 */
export interface ProjectSelectionRoutes {
	/** The positional stories-file argument as the command spells it, or null. */
	fileArgument: string | null;
	/** Whether the command registers `-p, --project <name>`. */
	projectOption: boolean;
}

/**
 * Derive the routes from a registered command's own arguments and options.
 *
 * Only an argument literally named `file` counts: `show <identifier>` also has a
 * positional, but offering it as a way to choose a board would be the same class
 * of false suggestion this module exists to remove.
 */
export function describeProjectSelection(command: Command): ProjectSelectionRoutes {
	const file = command.registeredArguments.find((argument) => argument.name() === "file");
	return {
		fileArgument: file ? (file.required ? `<${file.name()}>` : `[${file.name()}]`) : null,
		projectOption: command.options.some((option) => option.long === "--project"),
	};
}

/**
 * Compose the "no board selected" refusal from the routes that exist.
 *
 * House rule: a refusal names what would answer it. Naming a route the command
 * rejects is worse than naming none — the operator runs it, gets
 * `unknown option`, and now distrusts the next suggestion too. `defaultProject`
 * is always offered because it always works, so the sentence is never a dead
 * end even when a caller supplies no routes at all.
 */
export function selectProjectRefusal(routes: ProjectSelectionRoutes): string {
	const offers = [
		routes.fileArgument ? `provide a ${routes.fileArgument} argument` : null,
		routes.projectOption ? "pass --project <name>" : null,
		"set defaultProject in your config (or --context <name> for a context that defines one)",
	].filter((offer): offer is string => offer !== null);
	const list =
		offers.length === 1
			? (offers[0] as string)
			: `${offers.slice(0, -1).join(", ")}, or ${offers.at(-1)}`;
	return `No board selected: ${list}.`;
}
