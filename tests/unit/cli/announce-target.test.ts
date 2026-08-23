import { describe, expect, test } from "bun:test";
import { announceTarget } from "../../../src/cli/announce_target.ts";
import type { ResolvedConfig } from "../../../src/types.ts";

function capture(fn: () => void): string {
	const original = console.error;
	let out = "";
	console.error = (...args: unknown[]) => {
		out += `${args.join(" ")}\n`;
	};
	try {
		fn();
	} finally {
		console.error = original;
	}
	return out;
}

const config = {
	apiKey: "k",
	workspaceSlug: "archimedes",
	baseUrl: "https://plane.porcupine.works",
	dialect: "work-items",
	dialectSource: "detected",
	defaultProject: null,
	defaultLabels: [],
	sourceLabel: null,
	maxRetries: 5,
} as unknown as ResolvedConfig;

describe("resolved-target announcement", () => {
	test("names host, workspace, project and how the context was chosen", () => {
		const out = capture(() => announceTarget(config, "ce", "Data Platform"));
		expect(out).toContain("plane.porcupine.works");
		expect(out).toContain("archimedes");
		expect(out).toContain("Data Platform");
		expect(out).toContain("dialect work-items (detected)");
		expect(out).toContain("--context ce");
	});

	test("says LOUDLY when no context was given — the footgun case", () => {
		// Running without --context silently targets the other instance, and the
		// symptom is a cascade of bogus "parent not found" errors rather than
		// anything mentioning a server. Naming the default is the whole point.
		const out = capture(() => announceTarget(config, undefined, "Data Platform"));
		expect(out).toContain("default (bare PLANE_* env)");
	});

	test("goes to STDERR so --json stdout stays machine-clean", () => {
		const original = console.log;
		let stdout = "";
		console.log = (...a: unknown[]) => {
			stdout += a.join(" ");
		};
		try {
			capture(() => announceTarget(config, "ce", "P"));
		} finally {
			console.log = original;
		}
		expect(stdout).toBe("");
	});

	test("an IMPLICIT context is named, and marked implicit", () => {
		// With `defaultContext` or a single-context config the command line no
		// longer says which installation was used, so the announcement has to —
		// and it must distinguish "you asked for this" from "I chose it for you",
		// because only one of those is a mistake the user can see in their shell
		// history.
		const out = capture(() =>
			announceTarget(
				{ ...config, contextName: "ce" } as unknown as ResolvedConfig,
				undefined,
				"Data Platform",
			),
		);
		expect(out).toContain("context ce (implicit)");
		expect(out).not.toContain("bare PLANE_* env");
	});

	test("configured and fallback dialect provenance are explicit", () => {
		const configured = capture(() =>
			announceTarget({ ...config, dialectSource: "configured" } as unknown as ResolvedConfig, "ce"),
		);
		expect(configured).toContain("dialect work-items (configured)");

		const fallback = capture(() =>
			announceTarget(
				{
					...config,
					dialect: "issues",
					dialectSource: "fallback",
				} as unknown as ResolvedConfig,
				"ce",
			),
		);
		expect(fallback).toContain("dialect issues (fallback)");
	});
});
