import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `board fetch` is a paced live read. The opening line has to arrive while the
 * first request is still unanswered. A line that existed only in the completion
 * summary would never show up, because that request is held until the line does.
 */

function workItem(sequenceId: number): Record<string, unknown> {
	return {
		id: `item-${sequenceId}`,
		sequence_id: sequenceId,
		name: `Item ${sequenceId}`,
		state: { name: "Backlog", group: "backlog" },
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		description_html: "<p>Work.</p>",
	};
}

function respond(url: URL): Response {
	const path = url.pathname;
	if (path.endsWith("/work-items/") || path.endsWith("/issues/")) {
		if (url.searchParams.get("cursor") === "c1") {
			return Response.json({
				results: [workItem(3), workItem(4)],
				total_count: 4,
				next_page_results: false,
				next_cursor: "c2",
			});
		}
		return Response.json({
			results: [workItem(1), workItem(2)],
			total_count: 4,
			next_page_results: true,
			next_cursor: "c1",
		});
	}
	if (path.endsWith("/relations/")) return Response.json({});
	if (path.endsWith("/projects/")) {
		return Response.json({
			results: [{ id: "p1", name: "Data Platform", identifier: "DATA" }],
			next_page_results: false,
		});
	}
	return Response.json({ error: `unexpected ${path}` }, { status: 500 });
}

test("a paced board fetch prints an opening line immediately and an ETA while it runs", async () => {
	let released = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			while (!released) await Bun.sleep(5);
			return respond(new URL(req.url));
		},
	});
	const cwd = mkdtempSync(join(tmpdir(), "planestories-paced-"));
	mkdirSync(join(cwd, ".git"));
	writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(
		join(cwd, ".planestoriesrc.json"),
		JSON.stringify({
			apiKey: "test-key",
			workspaceSlug: "ws",
			baseUrl: `http://127.0.0.1:${server.port}`,
			dialect: "work-items",
			defaultProject: "Data Platform",
			apiRateLimit: 600,
		}),
	);
	const cli = join(import.meta.dir, "../../../src/cli/index.ts");
	const env: Record<string, string> = { FORCE_COLOR: "0", PLANE_MAX_RETRIES: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PLANE_") && value !== undefined) env[key] = value;
	}
	const proc = Bun.spawn(
		["bun", "run", cli, "board", "fetch", "-p", "Data Platform", "-c", ".planestoriesrc.json"],
		{ cwd, env, stdout: "pipe", stderr: "pipe" },
	);
	const stdout = new Response(proc.stdout).text();
	const decoder = new TextDecoder();
	const reader = proc.stderr.getReader();
	let err = "";
	const deadline = Date.now() + 8000;
	try {
		while (!err.includes("Paced run starting")) {
			if (Date.now() > deadline) {
				throw new Error(`opening line did not arrive while the first request was held\n${err}`);
			}
			const chunk = await reader.read();
			if (chunk.done) break;
			err += decoder.decode(chunk.value, { stream: true });
		}
		expect(released).toBe(false);
		expect(err).toContain("Paced run starting");
		expect(err).toContain("600/min");
		released = true;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			err += decoder.decode(chunk.value, { stream: true });
		}
		const code = await proc.exited;
		const out = await stdout;
		expect({ code, out, err }).toMatchObject({ code: 0 });
		expect(out).not.toContain("Paced run");
		expect(out).not.toContain("left");
		expect(out).not.toContain("paced:");
		expect(err).toMatch(/work items: 2\/4 \(~[0-9]+s left\)/);
		expect(err).toMatch(/relations: 1\/4 \(~[0-9]+s left\)/);
		expect(err).toContain("relations: 4/4");
		expect(err).toContain("paced:");
		expect(err.indexOf("Paced run starting")).toBeLessThan(err.indexOf("work items:"));
		expect(err.indexOf("work items:")).toBeLessThan(err.indexOf("relations:"));
		expect(err.indexOf("relations:")).toBeLessThan(err.indexOf("paced:"));
	} finally {
		released = true;
		if (proc.exitCode === null) proc.kill();
		await proc.exited;
		server.stop(true);
		rmSync(cwd, { recursive: true, force: true });
	}
});
