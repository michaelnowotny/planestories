import { describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import { ensureComment } from "../../../src/plane/issues.ts";

/**
 * A minimal structural stub for the comment surface ensureComment needs.
 * `failures` scripts createWorkItemComment behavior per call:
 *   "landed-lost"  — the comment IS stored, then a network-style error throws
 *                    (the ambiguous-write case behind the duplicate hazard)
 *   "transient"    — nothing stored, retryable error thrown
 *   "permanent"    — nothing stored, HTTP 400 thrown
 *   "ok"           — stored, resolves
 */
function stub(script: Array<"landed-lost" | "transient" | "permanent" | "ok">) {
	const comments: Array<{ comment_html: string }> = [];
	let createCalls = 0;
	return {
		comments,
		createCallCount: () => createCalls,
		client: {
			maxRetries: 3,
			listWorkItemComments: async <T>(_p: string, _w: string): Promise<T[]> =>
				comments as unknown as T[],
			createWorkItemComment: async <T>(
				_p: string,
				_w: string,
				body: Record<string, unknown>,
			): Promise<T> => {
				const mode = script[Math.min(createCalls, script.length - 1)];
				createCalls++;
				if (mode === "landed-lost") {
					comments.push({ comment_html: String(body.comment_html) });
					throw new PlaneApiError("Network error calling Plane API (POST .../comments/)");
				}
				if (mode === "transient") {
					throw new PlaneApiError("Plane API POST .../comments/ failed (503)", 503);
				}
				if (mode === "permanent") {
					throw new PlaneApiError("Plane API POST .../comments/ failed (400): bad", 400);
				}
				comments.push({ comment_html: String(body.comment_html) });
				return undefined as T;
			},
		},
		noSleep: { sleep: async () => {} },
	};
}

const MARK = "[planestories:test-mark]";
const BODY = `<p>${MARK} evidence</p>`;

describe("ensureComment ambiguous-write safety (A10: verify before replay)", () => {
	test("existing marker short-circuits (no create call)", async () => {
		const s = stub(["ok"]);
		s.comments.push({ comment_html: BODY });
		const out = await ensureComment(s.client as never, "p", "w", MARK, BODY, s.noSleep);
		expect(out).toBe("exists");
		expect(s.createCallCount()).toBe(0);
	});

	test("landed-but-lost response: verification finds the marker, NO duplicate posted", async () => {
		const s = stub(["landed-lost"]);
		const out = await ensureComment(s.client as never, "p", "w", MARK, BODY, s.noSleep);
		expect(out).toBe("posted");
		expect(s.createCallCount()).toBe(1); // never re-POSTed
		expect(s.comments.length).toBe(1); // exactly one comment on the board
	});

	test("true transient failure: verified absent, retried, succeeds", async () => {
		const s = stub(["transient", "ok"]);
		const out = await ensureComment(s.client as never, "p", "w", MARK, BODY, s.noSleep);
		expect(out).toBe("posted");
		expect(s.createCallCount()).toBe(2);
		expect(s.comments.length).toBe(1);
	});

	test("permanent 400: thrown immediately, no retry", async () => {
		const s = stub(["permanent"]);
		await expect(ensureComment(s.client as never, "p", "w", MARK, BODY, s.noSleep)).rejects.toThrow(
			"400",
		);
		expect(s.createCallCount()).toBe(1);
	});

	test("create is invoked with the client-level blind retry DISABLED", async () => {
		const seen: Array<{ maxRetries?: number } | undefined> = [];
		const s = stub(["ok"]);
		const spy = {
			...s.client,
			createWorkItemComment: async <T>(
				p: string,
				w: string,
				body: Record<string, unknown>,
				opts?: { maxRetries?: number },
			): Promise<T> => {
				seen.push(opts);
				return s.client.createWorkItemComment(p, w, body) as Promise<T>;
			},
		};
		await ensureComment(spy as never, "p", "w", MARK, BODY, s.noSleep);
		expect(seen).toEqual([{ maxRetries: 0 }]);
	});

	test("unverifiable state (verification read fails) rethrows WITHOUT replaying", async () => {
		const s = stub(["transient", "ok"]);
		let creates = 0;
		const flaky = {
			...s.client,
			createWorkItemComment: async <T>(
				p: string,
				w: string,
				body: Record<string, unknown>,
			): Promise<T> => {
				creates++;
				return s.client.createWorkItemComment(p, w, body) as Promise<T>;
			},
			listWorkItemComments: async <T>(): Promise<T[]> => {
				if (creates > 0) throw new PlaneApiError("list failed", 500);
				return s.client.listWorkItemComments("p", "w");
			},
		};
		await expect(ensureComment(flaky as never, "p", "w", MARK, BODY, s.noSleep)).rejects.toThrow(
			"503", // the ORIGINAL create error, not the list error
		);
		expect(creates).toBe(1); // never replayed a write it could not verify
	});

	test("transient failures exhaust the budget, then throw (no infinite loop)", async () => {
		const s = stub(["transient", "transient", "transient", "transient", "transient"]);
		await expect(ensureComment(s.client as never, "p", "w", MARK, BODY, s.noSleep)).rejects.toThrow(
			"503",
		);
		// budget = maxRetries + 1 initial = 4 create attempts with maxRetries 3
		expect(s.createCallCount()).toBe(4);
	});
});
