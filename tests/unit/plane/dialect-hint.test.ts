import { afterEach, describe, expect, test } from "bun:test";
import { PlaneApiError } from "../../../src/errors.ts";
import { createPlaneClient } from "../../../src/plane/client.ts";

/**
 * A relation-endpoint 404 must say WHY.
 *
 * Plane serves work items under two endpoint families — CE uses `/work-items/`,
 * Cloud uses `/issues/` — and the relation sub-resource 404s when you ask the
 * wrong one. The bare error reads as "this deployment has no relation API", and
 * two separate sessions independently reached that conclusion from it; one
 * decided the tool was newer than the server, the other designed a prose
 * fallback around a feature that was working the whole time. Both cost hours.
 *
 * The hint never switches dialect automatically: silently talking to a different
 * endpoint family than the one configured would be its own bug.
 */

// `createPlaneClient` takes no fetch injection, so the global is stubbed. The
// first draft of this file passed a `fetch` option that was silently ignored and
// the tests hit api.plane.so for real — three of four still "passed", which is
// the tidiest illustration of §10b in the repo.
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function clientThatFails(status: number, dialect: "issues" | "work-items") {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ detail: "Not found." }), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof globalThis.fetch;
	return createPlaneClient({ apiKey: "k", workspaceSlug: "ws", dialect, maxRetries: 0 });
}

describe("relation endpoint 404 → dialect hint", () => {
	test("a 404 on getRelations names the dialect in use AND the alternative", async () => {
		const client = clientThatFails(404, "issues");
		try {
			await client.getRelations("p", "i");
			throw new Error("expected a throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("dialect");
			// The one it IS using, so the reader can confirm their config...
			expect(message).toContain('"issues"');
			// ...and the one to try, in the exact form they must write.
			expect(message).toContain('"dialect": "work-items"');
			expect(message).toContain("PLANE_CTX_<NAME>_DIALECT=work-items");
		}
	});

	test("the hint points the OTHER way when already on work-items", async () => {
		const client = clientThatFails(404, "work-items");
		try {
			await client.getRelations("p", "i");
			throw new Error("expected a throw");
		} catch (error) {
			expect((error as Error).message).toContain('"dialect": "issues"');
		}
	});

	test("a non-404 failure is passed through untouched", async () => {
		// A 500 is a server problem, not a routing problem. Attaching a dialect
		// hint to it would send the reader to the one place that is not at fault.
		const client = clientThatFails(500, "issues");
		try {
			await client.getRelations("p", "i");
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(PlaneApiError);
			expect((error as Error).message).not.toContain("dialect");
		}
	});

	test("createRelation carries the hint too — the write path is where it bites", async () => {
		const client = clientThatFails(404, "issues");
		try {
			await client.createRelation("p", "i", "blocked_by", ["j"]);
			throw new Error("expected a throw");
		} catch (error) {
			expect((error as Error).message).toContain('"dialect": "work-items"');
		}
	});
});
