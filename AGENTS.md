# planestories — guide for coding agents

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
- `src/atlas/` — the **Project Atlas** visualizer (FORCE-DIRECTED dependency graph). `model.ts` builds an
  `AtlasGraph` (nodes + dependency `edges`) from either a parsed file (`buildAtlasFromFile`) or the shared
  `fetchProjectIndex` (`buildAtlasFromBoard(…, relationsById?)` — folds `kind: criterion` children into
  their parent's AC ring; any item parenting a non-criterion child is an epic). Edges: blocked_by/blocks →
  directed `"blocks"`, relates_to → undirected `"relates"`, deduped (mirror + unordered pair), self/dangling
  dropped. `quality.ts` = the light spec-quality overlay. `render.ts` = `renderAtlasHtml(graph)` → one
  self-contained HTML (inlined CSS/JS + embedded JSON with `</script>` unicode-escaped; NO D3/CDN) running a
  hand-rolled `<canvas>` force sim (repulsion + parent/dependency springs + gravity, alpha cooling; a
  ResizeObserver keeps the bitmap matched to its box). Polished visuals: soft **convex-hull cluster blobs**
  per epic in a stable golden-angle hue (so a big board reads as grouped regions), a **"Dependencies only"**
  toggle (`visible()`/`inDeps` — hides pure-hierarchy nodes to focus the web), a hover **tooltip**
  (`esc()`-escaped — the only innerHTML sink; the panel uses textContent/createElement), pill-backed labels
  (epics always, stories on zoom-in), curved edges + arrowheads, glow on hover/selected. ALL nodes shown by
  default; drag/pan/zoom/hover/click-details (progress bar + clickable dependency list). The `atlas` command
  fetches per-item relations (bounded, per-item failures DROP that item's edges + warn, `--no-dependencies`
  skips). Node ids reset per build (diff-stable). Verified on the live 665-item DATA board via headless
  screenshots (overview, deps-only, zoomed).

## Identity / idempotency (load-bearing)

Created items carry `external_source: "planestories"` + `external_id = slug(title)`; criterion
sub-items use `external_id = "<parent>::ac<n>"`. `plane_id`/`plane_identifier`/`plane_url`/
`plane_hash` are written back into each story's YAML. `plane_hash` powers skip-unchanged. **Never
add a `plane_status` key** — `status:` already is the state key.

## Architecture map, continued — the newer subsystems

- `src/sync/writeback.ts` — board→file **checkbox reverse-sync** (`groom --write-back`): pure
  `applyCheckboxStates` + `reverseSyncCriteria` board wrapper. Ticks a story's `- [x]`/`- [ ]` to
  match each legacy `::ac<n>` sub-item's board `stateGroup`, matched positionally, IN PLACE
  (preserves authored text — unlike `export --sync-criteria`, which regenerates the file).
  Dry-run default. Note it is a **file-only, exclusive mode** of `groom`, not additive.
- `src/sync/migrate.ts` — `migrate-criteria`: folds legacy `::ac<n>` CHILD items into the parent's
  description **task list** (the current criteria model — see `docs/DESIGN_criteria-as-tasklist.md`),
  plus `checkCriteriaMigration` (unmigrated / dual-representation drift) which `doctor` reports.
  Board-only, idempotent, dry-run default, conflict-fail, `--only` canary, `--json`.
- `src/sync/graph_check.ts` — board-side DANGLING relation detection (a relation whose target is
  not in the project). Owns the single paced relation sweep and **returns the relations map** so
  other doctor checks reuse it — never add a second sweep. Cycles are not checked board-side
  (Plane silently drops cycle-creating relations; `lint` checks them file-side).
- `src/sync/house_rules.ts` — the opt-in `doctor --house-rules` lints: open non-epic stories with
  no parseable `**Effort:**` line, and board-authored `Depends on:`/`Blocks:` prose whose targets
  have no matching relation (split `missing` vs `unknownTargets`). Consumes the shared relations
  map. **`doctor`'s default output must stay byte-stable** — it is a CI gate; new findings go
  behind a flag.
- `src/sync/story-diff.ts` — the `import --dry-run` field-level diff. It must mirror the apply
  path EXACTLY: the same field guards, the same resolved values (canonical state names, member
  ids, resolved labels, normalized parent identifiers), and the same failure ordering. Unresolvable
  values become NOTES, never phantom field changes. Descriptions compare at the canonical-markdown
  tier (both sides through `htmlToMarkdown`) so Plane's HTML reparse can't fake a body diff.
- `src/config/repo_config.ts` — `.planestories.yml`, a repo-local, committed, NON-secret
  conventions file (distinct from the JSON credentials/context config), discovered upward from cwd.
  v1: `lint.strictness`, `lint.disable`. Present-but-invalid fails loudly; disabled rules are
  printed, never silently dropped.
- `src/sync/setter.ts` — `set --evidence <note>`: append-only, idempotent evidence comments deduped
  by a content-hash marker via `ensureComment`. Works evidence-only (no field change → no PATCH).
- `src/replicate/` — the **replication engine** (whole-project migration between Plane deployments
  with exact `PROJECT-N` preservation). Operator contract: `docs/REPLICATE.md`; rationale and the
  cutover runbook: `docs/HANDOFF.md`.
  - `snapshot.ts` — the one expensive paced read → versioned, digest-bound, deterministically
    ordered JSON (`parseSnapshot` re-verifies the digest and the ascending-sequence invariant).
    Fail-hard: any read failure aborts and writes nothing.
  - `apply.ts` — the phased writer, driven ENTIRELY from the file (zero source reads). Serial
    ascending creates + gap placeholders + a per-create sequence assertion (exact identifiers);
    A10 create discipline (retries off; on an ambiguous create, reconcile by expected sequence +
    a strict fingerprint before ever re-POSTing); adoption requires a provably empty target.
  - `journal.ts` — append-only JSONL, fsync per record, **trailing newline is the commit marker**
    (bytes past the last newline are torn residue and are dropped), pid lockfile with
    non-clobbering restore, and ownership assertions before every append AND every Plane write
    (including inside the client's own retry loop).
  - `verify.ts` — the cutover gate. Journal-anchored (judges by the run's recorded mappings, never
    live guesswork), bidirectional set equality, normalized-DOM description comparison with a
    markdown-tier fallback that downgrades formatting-only differences to warnings.
  - `freshness.ts` — snapshot vs live drift. Item-level = 2 list calls; `--deep` also compares
    comments and relation sets, because comment/relation edits need not bump item `updated_at`.
  - `backup.ts` — dated snapshot + tear self-check + retention prune (atomic no-replace publish via
    temp + `link`; strict per-project filename pattern; prune only after a successful write).
  - `relink.ts` — rewrites `plane_id`/`plane_identifier`/`plane_url` across a markdown corpus from
    the journal mapping (atomic temp+rename). Without it, a cutover leaves every story file
    pointing at dead UUIDs.
  - `probe.ts` — capability + **endpoint-dialect** detection (`/issues/` vs `/work-items/`);
    `create.ts`, `gate.ts`, `instants.ts`, `report.ts` are its supporting pieces.

**State, roadmap, and what shipped when now live in `docs/HANDOFF.md` — deliberately NOT here.**
This file is the durable architecture map; keeping a changelog in it is how it went stale before.

The load-bearing gotchas, alternatives-not-chosen, and Plane-API findings are in
**`docs/DESIGN_DECISIONS_tier1.md`** — READ IT before touching effort/relations/lint. Verified Plane-API
facts: `point` integer-only; integer `point` persists with no estimate system; relations auto-mirror;
**Plane silently drops cycle-creating relations** (server-side backstop). Known limits:
`docs/KNOWN_LIMITATIONS.md`.

**Current state, roadmap, working rules, and the gotcha catalogue: `docs/HANDOFF.md` — the entry
point, read it first.** Design + locked decisions: `docs/DESIGN_DECISIONS_tier1.md` (Tier 1),
`docs/DESIGN_criteria-as-tasklist.md`, `docs/DESIGN_atlas-cockpit.md`; replication contract:
`docs/REPLICATE.md`; full CLI reference: `docs/USING_WITH_CLAUDE.md`.

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
