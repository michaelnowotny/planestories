import { describe, expect, test } from "bun:test";
import { type PayloadHashInput, payloadHash } from "../../../src/sync/content-hash.ts";

function baseInput(overrides: Partial<PayloadHashInput> = {}): PayloadHashInput {
	return {
		name: "As a user, I want to log in",
		descriptionHtml: "<p>Login description.</p>",
		priority: "high",
		status: "Backlog",
		estimate: 3,
		labels: ["Feature", "Auth"],
		assignee: "jane@company.com",
		syncCriteria: false,
		criteria: [],
		...overrides,
	};
}

describe("payloadHash", () => {
	test("is deterministic for identical input", () => {
		expect(payloadHash(baseInput())).toBe(payloadHash(baseInput()));
	});

	test("is a 16-char hex digest", () => {
		expect(payloadHash(baseInput())).toMatch(/^[0-9a-f]{16}$/);
	});

	test("ignores label ordering", () => {
		expect(payloadHash(baseInput({ labels: ["Feature", "Auth"] }))).toBe(
			payloadHash(baseInput({ labels: ["Auth", "Feature"] })),
		);
	});

	test("changes when the rendered description changes", () => {
		expect(payloadHash(baseInput())).not.toBe(
			payloadHash(baseInput({ descriptionHtml: "<p>Different.</p>" })),
		);
	});

	test("changes when name / priority / status / estimate / assignee change", () => {
		const base = payloadHash(baseInput());
		expect(payloadHash(baseInput({ name: "Other" }))).not.toBe(base);
		expect(payloadHash(baseInput({ priority: "low" }))).not.toBe(base);
		expect(payloadHash(baseInput({ status: "Done" }))).not.toBe(base);
		expect(payloadHash(baseInput({ estimate: 5 }))).not.toBe(base);
		expect(payloadHash(baseInput({ assignee: "bob@company.com" }))).not.toBe(base);
		expect(payloadHash(baseInput({ labels: ["Feature"] }))).not.toBe(base);
	});

	test("ignores criteria when syncCriteria is false", () => {
		const withoutCriteria = payloadHash(baseInput({ syncCriteria: false, criteria: [] }));
		const withCriteriaButNotSyncing = payloadHash(
			baseInput({ syncCriteria: false, criteria: [{ text: "does X", checked: false }] }),
		);
		expect(withCriteriaButNotSyncing).toBe(withoutCriteria);
	});

	test("includes criteria (and toggling sync) when syncCriteria is true", () => {
		const notSyncing = payloadHash(baseInput({ syncCriteria: false, criteria: [] }));
		const syncingEmpty = payloadHash(baseInput({ syncCriteria: true, criteria: [] }));
		// Toggling the flag alone changes the hash.
		expect(syncingEmpty).not.toBe(notSyncing);

		const syncingUnchecked = payloadHash(
			baseInput({ syncCriteria: true, criteria: [{ text: "does X", checked: false }] }),
		);
		const syncingChecked = payloadHash(
			baseInput({ syncCriteria: true, criteria: [{ text: "does X", checked: true }] }),
		);
		// A ticked box vs an unticked box is a different payload.
		expect(syncingChecked).not.toBe(syncingUnchecked);
	});
});
