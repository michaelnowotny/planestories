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
- `src/cli/commands/` — `import`/`export`/`delete`/`set`/`projects`/`groom`/`doctor`/`atlas`/`lint`/`packet`/`epic`.
  `src/types.ts` is the type home.
- `src/sync/rollup.ts` — the **epic rollup** (`epic` command). `rollupEpic` reuses packet's
  `collectDescendants`/`isEpic` to summarize an epic: leaf-story status breakdown, completion %
  (cancelled excluded from the denominator), Σ leaf effort + unestimated count, and blocked/blocking
  leaves. Read-only.
- `src/sync/packet.ts` — the **agent spec-packet** builder. `generatePacket` (board wrapper: resolve →
  `fetchProjectIndex` → resolve target by identifier → fetch relations for root+children, bounded) +
  pure `buildPacketStory`/`renderPacketMarkdown`. Emits a self-contained implementable brief (machine-
  readable YAML header + description + AC with board state + dependencies WITH current status + effort +
  parent epic + planning refs). An epic emits itself + every DESCENDANT's brief (nested epics included) and sums descendant dev-days.
  Read-only; stdout or `-o`.
- `src/markdown/directives.ts` — body-line "directive" conventions (`**Effort:**`, `**Depends on:**`,
  `**Blocks:**`). Effort detection runs on the CANONICAL form `htmlToMarkdown(markdownToHtml(splitBody(
  body).narrative))` so `marked` (a real CommonMark engine) owns all code/heading parsing and detection
  can't diverge from the hashed narrative. `parseYamlEffort` / `injectEffortLine` / dependency-directive
  parsing live here.
- `src/sync/relations.ts` — the dependency **reconciliation engine** (a GLOBAL post-create phase over a
  FRESH `fetchProjectIndex`, bounded to concurrency 6). Canonical block-edge keys dedup Plane's auto-mirror;
  removal only when BOTH endpoints are in the import batch AND `external_source=planestories`; SELECTIVE
  cycle handling (skip only cyclic edges, sync the rest); withhold `plane_hash` for skipped-edge stories.
  `src/plane/client.ts` gains `getRelations`/`createRelation`/`removeRelation`.
- `src/lint/` — `rules.ts` (10 offline mechanical rules) + `linter.ts` (parse fileset → run rules →
  exit code). PARENT-related rules resolve identifiers EXACTLY (matches import's exact parent lookup);
  DEPENDENCY rules resolve NORMALIZED (matches relations' case-insensitive resolution). Reuses the shared
  raw `classifyFileEpics` from `atlas/model.ts`.
- `src/atlas/` — the **Project Atlas** visualizer. `model.ts` builds an `AtlasGraph` from either a
  parsed file (`buildAtlasFromFile`) or the shared `fetchProjectIndex` (`buildAtlasFromBoard` — folds
  `kind: criterion` children into their parent story's AC ring, treats any item that parents a
  non-criterion child as an epic). `quality.ts` = the light heuristic spec-quality overlay
  (`assessQuality`, stories only). `render.ts` = `renderAtlasHtml(graph)` → one self-contained HTML
  string (inlined CSS/JS + embedded JSON with `</script>` unicode-escaped; hand-rolled tidy-tree
  layout, no D3/CDN). Node ids are reset per build so output is diff-stable.

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
the client's `listWorkItemComments`/`createWorkItemComment`. **Reverse-sync (board→file checkbox
ticking, decision #4) now SHIPPED** as `groom --write-back <files…>` — see `src/sync/writeback.ts`
(pure `applyCheckboxStates` core + `reverseSyncCriteria` board wrapper). It ticks/unticks a story's
`- [x]`/`- [ ]` boxes to match each criterion sub-item's board `stateGroup`, matched by the `::ac<n>`
positional index, IN PLACE (preserves authored text/ordering — unlike `export --sync-criteria`, which
regenerates the whole file). Dry-run by default; `--yes` writes.

Also since v0.2.0: **`export` emits `kind: epic`** for any item that parents a non-criterion child
(so exported files self-annotate the hierarchy), and the **`/rate-userstories` skill is epic-aware**
— it classifies epic/story, validates structure + epic→child hierarchy, uses type-specific rubrics,
and reads ACs as either inline `### Acceptance Criteria` or `kind: criterion` children (adapted from
an upstream linearstories enhancement; see `.claude/commands/rate-userstories.md` +
`docs/RATE_USERSTORIES.md`). Both are production-validated on the finance session's 800+-item board.

New since v0.3.1: **`atlas`** — an interactive, self-contained offline HTML visualizer of the story
tree (epics → stories → acceptance criteria) with pan/zoom, status/label/flagged filters, search, a
details panel, and a light spec-quality overlay. Renders from a file (offline, no creds) or the live
board. Inspired by Ijonas Kisselbach's Project Atlas in linearstories, rethought for Plane as a
zero-dependency artifact. Ref: `docs/ATLAS.md`; code in `src/atlas/` + `src/cli/commands/atlas.ts`.

**Tier 1 of the data-platform team's improvement brief (2026-07-28, all merged to `main`):**
- **Effort** (`85a83ae`) — decimal developer-day effort as a `**Effort:** N.n dev-days` body line
  (source of truth; round-trips via the description). `estimate`/`point` untouched (Plane `point` is
  integer-only — verified). `effort_days:` YAML is sugar.
- **Relations** (`c1ad503`) — `blocked_by`/`blocks`/`relates_to` (+ `**Depends on:**`/`**Blocks:**`
  sugar) synced to real Plane relations. See `src/sync/relations.ts` reconciliation rules above.
- **Lint** (`44108ad`) — `planestories lint <files…>`, offline CI gate, 10 rules, `--warn-only`.

**Tier 2 (in progress, 2026-07-28):**
- **AC checkbox reverse-sync** (`groom --write-back`, merged `4620542`) — in-place board→file checkbox
  ticking, keyed by `plane_id` (see the `src/sync/writeback.ts` note above; survived a 5-round Grok+Codex
  review, all edge cases fail closed).
- **Agent spec-packet** (`packet`, `src/sync/packet.ts`) — see the architecture-map note above.
- **Epic rollup** (`epic`, `src/sync/rollup.ts`) — see the architecture-map note above.

**Tier 3 (in progress):**
- **`doctor` dependency-graph checks** (`src/sync/graph_check.ts`) — board-side DANGLING relation
  detection (a blocked_by/blocks/relates_to whose target isn't in the project) folded into `doctor`'s
  findings/exit. Cycles are NOT checked board-side (Plane backstops them; lint checks them file-side).
- **`.planestories.yml` repo conventions** (`src/config/repo_config.ts`) — a repo-local, committed,
  non-secret conventions file (DISTINCT from the JSON credentials/context config), discovered upward from
  cwd. v1: `lint.strictness` (warn|error default mode) + `lint.disable` (rule ids to skip). `lint` reads
  it; `--warn-only` always wins; disabled rules are printed (never silently dropped); a present-but-invalid
  file fails loudly. Consumed in `src/lint/linter.ts` (`disabledRules`).
- Still pending: structured evidence log; then the **atlas dependency-graph overhaul** — user decisions
  CONFIRMED: force-directed/organic layout, show ALL nodes (see `docs/handoff-2026-07-28.md`).

The load-bearing gotchas, alternatives-not-chosen, and Plane-API findings are in
**`docs/DESIGN_DECISIONS_tier1.md`** — READ IT before touching effort/relations/lint. Verified Plane-API
facts: `point` integer-only; integer `point` persists with no estimate system; relations auto-mirror;
**Plane silently drops cycle-creating relations** (server-side backstop). Known limits:
`docs/KNOWN_LIMITATIONS.md`.

Design + locked decisions: `docs/DESIGN_DECISIONS_tier1.md` (Tier 1) +
`docs/plan-production-feedback-2026-07.md` (v2 slices); NEXT-SESSION handoff:
`docs/handoff-2026-07-28.md`; state/how-to: `docs/handoff-2026-07-17.md`; full CLI reference:
`docs/USING_WITH_CLAUDE.md`.

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
