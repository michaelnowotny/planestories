import { writeSync } from "node:fs";
import type { PacedProgressSink } from "../plane/client.ts";

/**
 * During-run progress for a paced command.
 *
 * The completion summary prints only after the command finishes, which is the
 * moment a killed run has already lost it. The opening line is written before
 * the first request. A phase names an ETA only once its total is known; a list
 * whose length is still unknown says so instead of inventing a remaining time.
 *
 * Writes go through the caller's function. Production uses `writeStderrNow`
 * because a pipe can hold ordinary stderr until the process exits.
 */
export class PacedProgress implements PacedProgressSink {
	private readonly phaseStarted = new Map<string, number>();
	private readonly sawMid = new Set<string>();
	private readonly lastPrint = new Map<string, number>();
	private openLabel: string | undefined;

	constructor(
		private readonly write: (chunk: string) => void,
		private readonly now: () => number = Date.now,
		private readonly style: (text: string) => string = (text) => text,
	) {}

	announce(line: string): void {
		if (this.openLabel !== undefined) {
			this.write("\n");
			this.openLabel = undefined;
		}
		this.write(`${this.style(line)}\n`);
	}

	phase(label: string, done: number, total: number | undefined): void {
		const now = this.now();
		if (!this.phaseStarted.has(label)) this.phaseStarted.set(label, now);
		if (done <= 0) return;
		const complete = total !== undefined && done >= total;
		if (!this.shouldPrint(label, done, complete, now)) return;
		const started = this.phaseStarted.get(label) ?? now;
		const text = formatPhaseProgress({
			label,
			done,
			total,
			elapsedMs: Math.max(0, now - started),
		});
		this.emit(label, text, complete);
		if (complete) {
			this.sawMid.delete(label);
			this.phaseStarted.delete(label);
			this.lastPrint.delete(label);
			return;
		}
		this.sawMid.add(label);
		this.lastPrint.set(label, now);
	}

	private shouldPrint(label: string, done: number, complete: boolean, now: number): boolean {
		if (complete) return true;
		if (!this.sawMid.has(label)) return true;
		if (done % 25 === 0) return true;
		const last = this.lastPrint.get(label) ?? 0;
		return now - last >= 2000;
	}

	private emit(label: string, text: string, complete: boolean): void {
		if (this.openLabel !== undefined && this.openLabel !== label) this.write("\n");
		const body = this.style(text);
		this.write(complete ? `\r${body}\n` : `\r${body}`);
		this.openLabel = complete ? undefined : label;
	}
}

/** Stderr that is visible while the process is still blocked on the network. */
export function writeStderrNow(chunk: string): void {
	writeSync(2, chunk);
}

export function formatPacedOpening(input: {
	baseUrl: string;
	workspaceSlug: string;
	project?: string;
	requestsPerMinute: number;
}): string {
	const host = input.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	const project = input.project?.trim();
	const projectPart = project ? ` · project ${project}` : "";
	return `Paced run starting · ${host} · workspace ${input.workspaceSlug}${projectPart} · ${input.requestsPerMinute}/min.`;
}

export function formatPhaseProgress(input: {
	label: string;
	done: number;
	total: number | undefined;
	elapsedMs: number;
}): string {
	const elapsed = formatDuration(input.elapsedMs);
	if (input.total === undefined) {
		return `  ${input.label}: ${input.done} so far, ${elapsed} elapsed (total unknown, no estimate)`;
	}
	if (input.done >= input.total) {
		return `  ${input.label}: ${input.total}/${input.total} done in ${elapsed}`;
	}
	const remainingMs = (input.elapsedMs / input.done) * (input.total - input.done);
	return `  ${input.label}: ${input.done}/${input.total} (~${formatDuration(remainingMs)} left)`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutesTotal = Math.floor(seconds / 60);
	if (minutesTotal < 60) {
		const rem = seconds % 60;
		return rem === 0 ? `${minutesTotal}m` : `${minutesTotal}m${rem}s`;
	}
	const hours = Math.floor(minutesTotal / 60);
	const minutes = minutesTotal % 60;
	return `${hours}h${minutes}m`;
}
