# Using planestories from a Claude Code session

A reusable handoff brief. Give this file (or its contents) to any Claude Code session, in
any project, that should use **planestories** to turn markdown user stories into Plane
work items. Nothing here is specific to a particular repository.

---

## What planestories is

`planestories` is a CLI that syncs markdown user stories — with explicit, testable
acceptance criteria — into work items in [Plane](https://plane.so). Write your plan as
structured stories with `- [ ]` acceptance criteria, push them to Plane as tracked work
items, and use those criteria as your own definition-of-done while you build. It's a fork
of the MIT-licensed `linearstories`, ported to Plane.

## Where it is

- Repo: the planestories checkout (on this machine: `~/PycharmProjects/planestories`).
- Bun/TypeScript project, independent of whatever project you're working in.
- Worth skimming: `README.md`, `docs/USER_STORY_FORMAT.md`, `templates/user-story.md`.

## Setup

- Bun is required (installed at `~/.bun/bin`). In a fresh shell:
  `export PATH="$HOME/.bun/bin:$PATH"`.
- Install deps if `node_modules` is missing: run `bun install` in the repo.
- Credentials live in `planestories/.env` (`PLANE_API_KEY` + `PLANE_WORKSPACE_SLUG`). The
  CLI auto-loads `.env` from its own directory, so **run commands from inside the
  planestories repo**.
- 🔒 **Never print, echo, commit, or paste the API key.** Credentials belong only in the
  gitignored `.env`. If `.env` is missing, ask the operator to create it from
  `.env.example` — do not invent or request the key in plaintext in the conversation.

## Story format

```markdown
---
project: "My Project"          # the Plane PROJECT name (Plane has no "team" tier)
---

## As a <role>, I want <goal>, so that <benefit>

```yaml
plane_id:                      # leave the three plane_* fields empty for new stories
plane_identifier:
plane_url:
priority: high                 # urgent | high | medium | low | none
labels: [Feature]              # skipped with a warning if absent (see --create-labels)
estimate: 3
assignee: someone@example.com  # resolved by email to a project member
status: Backlog                # must match a state name in the project
```

<description in markdown — rendered to HTML in Plane>

### Acceptance Criteria
- [ ] concrete, testable criterion
- [ ] another one
```

A single file can hold many stories (each `## ` heading is one). Frontmatter sets the
default project; per-story overrides are not needed for the project in v1. Start from
`templates/user-story.md`.

## Commands

Run all of these from inside the planestories repo:

```bash
export PATH="$HOME/.bun/bin:$PATH"

# Faithful preview — reads the board read-only, reports exactly what apply would do
# (would create / would update / unchanged / would skip a duplicate), makes NO writes:
bun run src/cli/index.ts import /path/to/stories.md --dry-run

# Also validate that status/assignee/label/parent resolve (adds read-only checks):
bun run src/cli/index.ts import /path/to/stories.md --dry-run --check

# Create/update work items and write plane_id/plane_identifier/plane_url back into the file:
bun run src/cli/index.ts import /path/to/stories.md

#   --create-labels   create labels that don't exist instead of skipping them
#   --sync-criteria   sync each acceptance criterion to a Plane sub-item (state from its checkbox)
#   --source-label N  tag every created item with label N (auto-created; opt-in, also via config)
#   --project "Name"  override the project for all stories
#   --force           re-import even when content is unchanged (bypass skip-unchanged)
#   --status-only     update ONLY the state of already-linked items (skip unlinked)
#   --adopt-duplicates link a single exact-title match instead of skipping it
#   --force-create    create even when a same-title item exists (bypass the guard)
#   --strict          refuse headings with no yaml block AND no acceptance criteria
#   --no-write-back   don't modify the markdown file

# Export back to markdown (HTML description -> markdown; checklists survive):
bun run src/cli/index.ts export --project "My Project" -o exported.md
#   --external-source         export only items planestories created (no demo/other noise)
#   --label NAME / --status S filters (--status is repeatable); --open-only keeps open items
#   --sync-criteria rebuilds checklists from sub-items; parent/kind are emitted too

# Groom a project: close orphaned criterion sub-items (parent Done), report rot.
bun run src/cli/index.ts groom --project "My Project"          # dry-run report
bun run src/cli/index.ts groom --project "My Project" --yes    # apply (close sub-items)

# Doctor: read-only CI check; exits non-zero on findings (board rot).
bun run src/cli/index.ts doctor --project "My Project"

# Discover the workspace's projects (identifier + name) — use either with --project:
bun run src/cli/index.ts projects

# Move a card's state without editing YAML:
bun run src/cli/index.ts set PROJ-12 --status "In Progress" --project "My Project"

# Clean up test items — scoped + safe (dry-run, then --yes to confirm):
bun run src/cli/index.ts delete /path/to/stories.md --dry-run
bun run src/cli/index.ts delete /path/to/stories.md --yes               # by the file's plane_ids
bun run src/cli/index.ts delete --external-source --project "My Project" --yes  # all items it created
```

The stories markdown file can live anywhere — pass any path.

## Choosing a Plane project

A workspace usually has several projects; target one at four levels (highest first):
`--project "Name"` (forces all stories) → a per-story `project:` in the YAML block →
the file's frontmatter `project:` → `defaultProject` in config. So one file can route
different stories to different projects, and `--project` overrides everything. You can use
either the display name or the project identifier (e.g. INFRASETUP). Run
`planestories projects` to list them. Unknown names fail loudly with a suggestion and the
available list — use `--dry-run --check` to validate routing first.

Confirm the target project(s) with the operator. For a low-risk first run, use a sandbox
project and clean up afterward with `delete`. To track real work, pick the appropriate
project.

## Idempotency & write-back

- After a successful create, `plane_id` (UUID), `plane_identifier` (e.g. `PROJ-12`),
  `plane_url`, and `plane_hash` are written back into each story's YAML block.
- Re-running an import is **idempotent** via write-back: a story with a `plane_id` updates
  by UUID. A story WITHOUT a `plane_id` whose title matches an existing item is treated as a
  **duplicate** (skip-with-warning; `--adopt-duplicates` to link) — NOT a silent update — so a
  second file can never hijack the first file's work item. `--dry-run` reports these outcomes
  faithfully (it reads the board but writes nothing).
- **Duplicate guard:** before creating a brand-new story, planestories checks for an item
  with the exact same title already in the project (any creator). Default is skip-with-warning
  (`duplicate of ENG-42 (Backlog)`); `--adopt-duplicates` links a single exact match (multiple
  matches = hard error — set `plane_id` manually); `--force-create` creates anyway. The check
  uses one project listing per run (shared with the hashless-linked adopt), never per-item GETs.
- **`--status-only`** is a targeted mode for bulk state transitions (e.g. closing a batch
  of tickets): for each story that already has a `plane_id`, it PATCHes only the `state`
  (from the yaml `status`) and touches nothing else — no description re-render, no title or
  label clobber. Stories without a `plane_id` are skipped with a warning (import them fully
  first). It deliberately does NOT rewrite `plane_hash` (only the state was synced), so a
  later full import still re-pushes a genuinely-changed body.
- **Skip-unchanged:** a linked story whose content matches its stored `plane_hash` is
  reported as `unchanged` and makes **zero** API writes — so re-importing a large,
  mostly-static board is cheap and safe. `plane_hash` is a hash of the rendered payload
  (description as HTML, priority, state, estimate, labels, assignee, and — with
  `--sync-criteria` — the checklist), so cosmetic markdown reflow won't trigger a write.
  Pass `--force` to re-import regardless. (An out-of-band edit made in the Plane UI while
  the file is untouched is intentionally NOT detected here — that half of the reconcile
  loop belongs to the forthcoming `groom` reverse-sync.)

## Caveats

- Priorities are strings (`urgent`/`high`/`medium`/`low`/`none`); legacy Linear integers
  `0–4` are still accepted.
- Missing labels are skipped with a warning unless you pass `--create-labels`.
- `status` must match an existing **state name** in the project (e.g. `Backlog`, `Todo`,
  `In Progress`, `Done`); unknown states are ignored.
- `assignee` resolves by email (or display name) to a **project member**.
- Export converts Plane's HTML description back to markdown — headings and
  `- [ ]`/`- [x]` checklists survive an export → re-import round-trip.
- **Export writes `plane_hash` too, so an export → import round-trip starts warm:**
  re-importing an unedited exported file reports every story as `unchanged` and makes
  zero writes (rather than blind-rewriting every description). This holds when the import
  uses the same `--sync-criteria` flag as the export and no extra default/source labels
  are configured — the normal round-trip. Edit a story and only that story re-syncs.
- **Legacy `plane_id`-without-`plane_hash` files** (linked before skip-unchanged existed, or
  hand-authored) don't blind-write: import reconstructs the board item from one project
  listing and adopts the hash when the content already matches — else it updates normally.
- Use `delete` to clean up after a sandbox run (scoped to your files or to
  `--external-source`, behind `--yes`). `delete --archive` is the recoverable
  alternative: it applies an `archived` label (works on any state) instead of
  hard-deleting, and archived items are hidden from `export` by default.
- Targets Plane Cloud by default; `PLANE_BASE_URL` / `baseUrl` can point at a self-hosted
  instance.
- Transient Plane API failures (HTTP 429 rate limits, 5xx, network blips) are retried
  automatically — honoring `Retry-After` when present, else exponential backoff with jitter.
  Tune with `PLANE_MAX_RETRIES` (default 5; 0 disables). Bulk imports/grooms of large boards
  no longer fall over on a rate limit.
- Extra yaml keys: `parent: DATA-N` nests a story under an existing item (epic in another file);
  `kind` (story/criterion/epic) is informational; `comment: "..."` posts a one-time evidence note
  on create/update/status-change (idempotent — a re-run won't duplicate it). Use `groom` after a
  batch of work completes to close the now-orphaned acceptance-criteria sub-items, and `doctor`
  in CI to fail a build when board rot exists.

## Optional: you're doing a shakedown / test run

If the operator asked you to evaluate planestories (not just use it), use it for real,
then write concrete feedback — anything broken, confusing, or surprising (error messages,
the markdown format, resolver behavior, idempotency, write-back, export quality, docs
gaps, ergonomics), plus what you'd change if it were your tool. Save the feedback to a
file in the project you're working in (e.g. `external_info/planestories-feedback.md`) and
tell the operator it's ready so they can forward it to the planestories maintainer.
