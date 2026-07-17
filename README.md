# planestories

A CLI tool that bridges markdown-based user stories and [Plane](https://plane.so) work items, enforcing user story and acceptance-criteria discipline for AI agent-driven development.

> **Attribution.** planestories is a fork of [**linearstories**](https://github.com/stackingturtles/linearstories) by **Ijonas Kisselbach / Stacking Turtles Ltd.**, adapted to target Plane instead of Linear. The original is MIT-licensed; that license is preserved in full (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE)). Huge thanks to the original author.

## Why structured acceptance criteria matter for AI agents

AI coding agents — Claude Code, Cursor, Copilot Workspace, and others — perform dramatically better when given precise, testable acceptance criteria. Vague tickets like "improve the login flow" lead to ambiguous implementations and wasted iteration cycles. Structured user stories with explicit acceptance criteria give agents the deterministic guardrails they need:

- **Clear scope boundaries.** Each acceptance criterion is a discrete, verifiable condition.
- **Testable by default.** Criteria written as checkboxes (`- [ ] ...`) map directly to test cases.
- **Markdown as the source of truth.** Stories live in your repository alongside the code.
- **Two-way sync with Plane.** Managers keep their board current; agents keep their specs current.

## Quick start

### 1. Install

Run directly with `bunx` (no install required):

```bash
bunx planestories import stories/*.md
```

Or install globally / build a binary:

```bash
bun install -g planestories
# or build from source:
bun install
bun build src/cli/index.ts --compile --outfile planestories
```

### 2. Provide credentials (never commit them)

Credentials live in a **gitignored `.env`** file — never in a committed config. Copy `.env.example` to `.env` and fill in:

```bash
PLANE_API_KEY=plane_api_xxxxxxxxxxxxxxxxxxxx      # Plane > Profile Settings > Personal Access Tokens
PLANE_WORKSPACE_SLUG=your-workspace-slug          # the app.plane.so/<slug>/... part of your URL
# PLANE_BASE_URL=https://api.plane.so             # only override when self-hosting
```

### 3. Add non-secret defaults (optional)

Create `.planestoriesrc.json` in your project root for **non-secret** defaults. **Do not put `apiKey` here** — it comes from `.env`.

```json
{
  "workspaceSlug": "your-workspace-slug",
  "baseUrl": "https://api.plane.so",
  "defaultProject": "Q1 2026 Release",
  "defaultLabels": ["User Story"]
}
```

`PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, and `PLANE_BASE_URL` from the environment always override config-file values.

### 4. Write your first story

Create `stories/login.md` (see [`templates/user-story.md`](./templates/user-story.md)):

````markdown
---
project: "Q1 2026 Release"
---

## As a user, I want to log in so that I can access my account

```yaml
plane_id:
plane_identifier:
plane_url:
priority: high
labels: [Feature, Auth]
estimate: 3
assignee: jane@company.com
status: Backlog
```

User should be able to log in with their email and password.

### Acceptance Criteria

- [ ] User can enter email and password on the login page
- [ ] Invalid credentials show a clear error message
````

### 5. Import

```bash
planestories import stories/*.md            # create/update work items, write ids back
planestories import stories/*.md --dry-run  # preview: reports exactly what apply would do, no writes
```

`--dry-run` is **faithful** — it consults the board read-only (one memoized listing) and reports the same per-story outcome apply would produce (`would create` / `would update` / `unchanged` / `would skip` a duplicate) — it just never writes. Add `--check` to also validate that each `status` / `assignee` / `label` / `parent` resolves.

After a successful import, `plane_id` (the work item UUID), `plane_identifier` (e.g. `ENG-42`), and `plane_url` are written back into each story's YAML block.

## How fields map to Plane

| Story field | Plane |
|---|---|
| `project` (per-story / frontmatter / `--project`) | the work item's **project** (required — Plane has no "team" tier) |
| `## Heading` | work item name |
| body markdown | `description_html` (converted to HTML) |
| `priority` | `urgent` / `high` / `medium` / `low` / `none` (legacy Linear integers `0–4` are also accepted) |
| `status` | work item **state** (resolved by name within the project) |
| `labels` | label UUIDs (resolved by name within the project) |
| `assignee` | member UUID (resolved by email or display name) |
| `estimate` | story `point` |
| `plane_id` | work item UUID (used to update) |
| `plane_hash` | content hash of the last sync (auto-managed) — powers skip-unchanged |
| `parent` | nests this item under an existing one (`parent: DATA-12`; resolved by identifier) |
| `kind` | `story` / `criterion` / `epic` — informational; emitted by export, read on import |
| `comment` | optional evidence note posted once (idempotently) on create/update/status change |

### Choosing the project

A workspace usually has several projects. You can target any of them at three levels of
granularity (highest precedence first):

1. **`--project "Name"`** on the command — forces *all* stories in that run into one project.
2. **Per-story `project:`** in a story's YAML block — routes that single story.
3. **File frontmatter `project:`** — the default for every story in the file.
4. **`defaultProject`** in config — the fallback when nothing else is set.

So one file can fan stories out to different projects:

````markdown
---
project: "True Cost"          # file default
---

## A story that goes to Infrastructure Setup

```yaml
project: Infrastructure Setup  # per-story override
```
...

## A story that uses the file default (True Cost)
...
````

A project can be given by its **display name** ("Infrastructure Setup") or its **identifier**
("INFRASETUP" — stable and typo-resistant). Run `planestories projects` to list both for your
workspace. An unknown name fails loudly and suggests the closest match plus the available list
(`Project not found: "Infrastructure". Did you mean "Infrastructure Setup"? Available projects: ...`).
Use `--dry-run --check` to validate routing before importing.

### Idempotency, skip-unchanged & duplicates

On create, planestories stamps each work item with `external_id` (derived from the story title) and `external_source: "planestories"`, then writes `plane_id` back into the file. Re-running the import updates that item **by its `plane_id`** — never duplicating. A story that has **no** `plane_id` but whose title matches an existing item is treated as a duplicate (see below), so a second file can't silently overwrite the first file's work item — link it explicitly with `--adopt-duplicates` (or add the `plane_id`) when that's what you intend.

- **Skip-unchanged.** Each synced story stores a `plane_hash` (a hash of the rendered payload). On re-import, a linked story whose content is unchanged is reported `unchanged` and makes **zero API writes** — so re-importing a large, mostly-static board is cheap. Cosmetic markdown reflow that renders to the same HTML doesn't count as a change. `--force` re-imports regardless. (An edit made in the Plane UI while the file is untouched is intentionally not pulled back by import — that's a future `groom` reverse-sync's job.)
- **Warm export → import.** `export` writes `plane_hash` too, so re-importing an unedited exported file is all-`unchanged` (no blind description rewrites). For files that carry a `plane_id` but no `plane_hash` (legacy or hand-authored), import reconstructs the board item from a single project listing and adopts the hash if the content already matches — one list call, never a per-item fetch.
- **Duplicate guard.** Before creating a brand-new story, planestories checks whether an item with the **exact same title** already exists in the project (created by anyone). By default it **skips with a warning** (`duplicate of ENG-42 (Backlog)`), so you never get accidental twins. Pass `--adopt-duplicates` to link a single exact match instead (multiple matches are a hard error — set `plane_id` manually), or `--force-create` to create anyway.

### Identifying planestories items

Every created work item is stamped with `external_source: "planestories"` — that's how
`delete`/`export --external-source` and idempotent matching find them. That field is an
API field, though, and isn't shown in Plane's normal board views. If you also want a
**visible** marker, set a **source label** (opt-in, off by default): `sourceLabel` in
config, `PLANE_SOURCE_LABEL` in the environment, or `--source-label <name>` per run. When
set, every created item is tagged with that label (auto-created — no `--create-labels`
needed), so humans can see and filter "what came from planestories" in the Plane UI.

### Missing labels

By default, labels that don't exist in the project are **skipped with a warning** (deduped, one line per label). Pass `--create-labels` to create them instead.

### Acceptance criteria as sub-items (`--sync-criteria`)

By default a story's `### Acceptance Criteria` checklist is stored in the work item's description. Pass `--sync-criteria` to instead sync **each criterion to a Plane sub-item** (a child work item). A `- [x]` maps to a completed-group state and `- [ ]` to an open state, so ticking a box in markdown moves the sub-item — and `export --sync-criteria` reconstructs the checklist from the sub-items' states. The mapping is idempotent (keyed per criterion), so re-imports update in place.

## Commands

### `import`

```
planestories import <files...> [options]
  -c, --config <path>     Config file path
  --context <name>        Select a named context from a multi-context config
  -p, --project <name>    Force all stories into this project (overrides frontmatter)
  --create-labels         Create labels that don't exist instead of skipping
  --source-label <name>   Tag every created item with this label (auto-created)
  --sync-criteria         Sync each acceptance criterion to a Plane sub-item
  --status-only           Update ONLY the state of already-linked items (skip unlinked)
  --force                 Re-import even when content is unchanged (bypass skip-unchanged)
  --adopt-duplicates      Link a single exact-title match instead of skipping it
  --force-create          Create even when a same-title item exists (bypass the duplicate guard)
  --strict                Refuse headings with no YAML block and no acceptance criteria
  --dry-run               Preview without writing to Plane
  --check                 With --dry-run, validate read-only (project/state/assignee/labels)
  --no-write-back         Skip writing Plane ids back into the markdown
```

`--status-only` is the mode for bulk state transitions (e.g. closing a batch of tickets): for every story that already has a `plane_id` it PATCHes only the `state` (from `status:`) and touches nothing else — no description re-render, no title/label clobber. Unlinked stories are skipped with a warning.

### `export`

```
planestories export [options]
  -o, --output <file>       Output file (default ./exported-stories.md)
  -p, --project <name>      Project to export from (required if no defaultProject)
  -i, --issues <ids>        Comma-separated work item identifiers (e.g. ENG-8)
  -s, --status <state>      Filter by status (repeatable — keeps items matching any)
  --open-only               Only export open items (backlog/unstarted/started)
  -a, --assignee <email>    Filter by assignee email
  -l, --label <name>        Filter by label name
  --external-source [src]   Only export items planestories created (default: planestories)
  --sync-criteria           Reconstruct acceptance criteria from sub-items
  --include-archived        Include items carrying the 'archived' label (excluded by default)
```

Export converts Plane's HTML description back to markdown (headings and `- [ ]`/`- [x]` checklists survive a round-trip), and emits stories in ascending identifier order. It also emits `parent`/`kind` structure and writes `plane_hash`, so re-importing an unedited exported file is all-`unchanged` (see [Idempotency, skip-unchanged & duplicates](#idempotency-skip-unchanged--duplicates)).

### `projects`

List the projects in your workspace (identifier + name) — handy for first-run setup and for
choosing the right `--project` value.

```
planestories projects
```

### `set`

Update fields on existing work items by identifier — handy for moving a card without editing YAML.

```
planestories set <identifiers...> [options]   # e.g. set ENG-12 ENG-13 --status "In Progress"
  -p, --project <name>    Project (required if no defaultProject)
  -s, --status <state>    Set the state by name
  --priority <level>      urgent | high | medium | low | none
  -a, --assignee <email>  Set the assignee by email
```

### `delete`

Delete (or archive) work items — **scoped only**, never a blunt project wipe. Either by the files' `plane_id`s (which clears `plane_*` back out as the inverse of import) or by `external_source` within a project.

```
planestories delete <files...> [options]
planestories delete --external-source [src] --project <name> [options]
  --archive               Archive instead of hard delete (applies an 'archived' label)
  --archive-label <name>  Label to apply when archiving (default: archived)
  --dry-run               Show what would be deleted, change nothing
  -y, --yes               Confirm deletion (required — without it, only the plan is shown)
  --no-write-back         Don't clear plane_* out of files after deletion
```

**Archiving** uses a label, not Plane's native archive (which is restricted to
completed/cancelled items). `delete --archive` applies the `archived` label (recoverable —
just remove the label; works on any state) and leaves the work item in place. Archived
items are excluded from `export` by default (pass `--include-archived` to see them).

### `groom`

Reconcile a project (dry-run by default; `--yes` to apply). Keeps a board tidy as work
completes on it:

```
planestories groom --project <name> [--yes]
```

- **Closes orphaned criterion sub-items** — an open `--sync-criteria` sub-item whose parent
  is Done/Cancelled is moved to a completed state, with an idempotent "auto-closed with parent"
  comment. **Only planestories criterion sub-items are ever closed** — a real child *story* of
  a done epic is never touched.
- **Reports** duplicate-title work items and criterion sub-items whose parent no longer exists.

### `doctor`

A read-only CI health check over the same analysis — prints board rot and **exits non-zero on
findings** (pass `--no-fail-on-findings` to just report):

```
planestories doctor --project <name>
```

## Reliability

Every Plane API call retries transient failures automatically — HTTP 429 (honoring `Retry-After`), 5xx, and network blips — with exponential backoff plus jitter (capped at 30s). So a large bulk import or close won't fall over on a rate limit. Tune the retry budget with `PLANE_MAX_RETRIES` (default `5`; `0` disables). After the retries are exhausted the error surfaces, and per-story failures never abort the run — the summary lists the failed items.

## Self-hosting

planestories works against Plane Cloud by default (`https://api.plane.so`). To target a self-hosted instance, set `PLANE_BASE_URL` (env) or `baseUrl` (config) to your instance URL — no code changes required.

## Multiple workspaces (contexts)

A config file may define named contexts; select one with `--context <name>`:

```json
{
  "contexts": [
    { "name": "orgA", "workspaceSlug": "org-a", "defaultProject": "Q1 Release" },
    { "name": "orgB", "workspaceSlug": "org-b", "defaultProject": "Brand Refresh" }
  ]
}
```

## Development

```bash
bun install
bun test            # run the test suite
bun run lint        # biome
```

## License

MIT. See [`LICENSE`](./LICENSE) (original © Stacking Turtles Ltd.) and [`NOTICE`](./NOTICE) for attribution and modification copyright.
