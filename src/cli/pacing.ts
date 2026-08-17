import chalk from "chalk";
import type { PlaneClient } from "../plane/client.ts";

/** Print completion telemetry only when this client has an active rate profile. */
export function reportPacing(client: PlaneClient): void {
	const summary = client.pacingSummary();
	if (summary !== undefined) console.error(chalk.dim(summary));
}
