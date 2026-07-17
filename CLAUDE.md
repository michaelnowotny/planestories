# planestories — guide for Claude

planestories is a CLI that syncs markdown user stories (with checkbox acceptance criteria)
to [Plane](https://plane.so) work items, both directions. It's a TypeScript/Bun fork of
**linearstories** (Ijonas Kisselbach / Stacking Turtles Ltd., MIT), retargeted from Linear to
Plane's REST API. The point: give coding agents a precise, checkable spec instead of a vague
ticket.

## Working here (must-follow)

- **Bun, not Node.** `export PATH="$HOME/.bun/bin:$PATH"` in every shell, then `bun install`.
  Keep green before any commit: `bun test`, `bunx tsc --noEmit`, `bunx biome check ./src ./tests`
  (`bunx biome check --write` auto-fixes format + import order).
- **Biome formats with TABS.** The Edit tool silently fails to match when leading whitespace
  differs — match an inner substring (no leading whitespace) and let `biome --write` reindent,
  or Write the whole file.
- **Tests use a fake client** (`tests/helpers/fake-plane-client.ts`). Any new `PlaneClient`
  method must be added there too, or real-flow tests throw.
- **Live-test only in a SANDBOX Plane project** (creds in the gitignored `.env`) — never a
  production board. `.env` holds real credentials; never print or commit it.

## Model: two sources of truth

The markdown file owns **content** (title, body, criteria, priority, labels); the Plane board
owns **state/completion**. Import pushes content file→board and only when it actually changed
(content hash). A future `groom` pulls state board→file. Don't blur these.

## Architecture map

- `src/plane/client.ts` — REST client. `request()` wraps every call in transient-failure retry
  (429/5xx/network, `Retry-After` or exponential backoff+jitter; `PLANE_MAX_RETRIES`). Never add
  a parallel HTTP path.
- `src/plane/issues.ts` — create/update/fetch + `fetchWorkItems`, and `fetchProjectIndex`
  (ONE paginated list → `byId`/`byIdentifier`/`byNormalizedTitle`/`childrenByParent`; the shared
  read that backs the duplicate guard and hashless-linked adopt — never a per-item GET loop).
- `src/plane/resolvers.ts` — name→UUID resolution (project/state/label/member), cached per run.
- `src/sync/` — the verbs: `importer.ts`, `exporter.ts`, `deleter.ts`, `setter.ts`.
  - `content-hash.ts` = `payloadHash()` (pure). `story-hash.ts` = `hashStoryPayload(story, opts)`
    is the **single source of truth** for a story's content hash — importer AND exporter call it
    so write-time and read-time hashes can't drift. Do not inline the hash-field assembly anywhere.
  - `board-story.ts` = `boardItemToStory()` — the one board-item→UserStory conversion, shared by
    exporter (serialize) and importer (reconstruct board state for adopt).
- `src/markdown/` — `parser.ts`/`serializer.ts` (YAML keys incl. `plane_hash`), `writer.ts`
  (`writeBackIds`/`clearWriteBack`), `criteria.ts` (`splitBody`/checklist), `html.ts`
  (`markdownToHtml`/`htmlToMarkdown`).
- `src/cli/commands/` — `import`/`export`/`delete`/`set`/`projects`. `src/types.ts` is the type home.

## Identity / idempotency (load-bearing)

Created items carry `external_source: "planestories"` + `external_id = slug(title)`; criterion
sub-items use `external_id = "<parent>::ac<n>"`. `plane_id`/`plane_identifier`/`plane_url`/
`plane_hash` are written back into each story's YAML. `plane_hash` powers skip-unchanged. **Never
add a `plane_status` key** — `status:` already is the state key.

## Current state (v2 — all slices shipped)

On `main`: **1** rate-limit backoff · **2** skip-unchanged (`plane_hash`) · **3**
`import --status-only` · **4** shared `fetchProjectIndex` + duplicate guard + hashless-linked
adopt · export writes `plane_hash` (warm round-trips) · **5** export completeness (`parent`/`kind`,
`--open-only`/repeatable `--status`) · **6** `groom` (close orphaned criterion sub-items; report
duplicates/parentless — the cascade closes ONLY criterion children, NEVER story children of a Done
epic) · **7** cross-file `parent`, `import --strict` guard, `comment:` evidence notes, `doctor`
(CI wrapper, non-zero on findings). Groom/doctor live in `src/sync/groomer.ts` +
`src/cli/commands/{groom,doctor}.ts`; comments go through `ensureComment` (marker-idempotent) on
the client's `listWorkItemComments`/`createWorkItemComment`. Reverse-sync (board→file checkbox
ticking) is the one deferred piece (decision #4). Design + locked decisions:
`docs/plan-production-feedback-2026-07.md`; state/how-to: `docs/handoff-2026-07-17.md`; full CLI
reference: `docs/USING_WITH_CLAUDE.md`.

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
