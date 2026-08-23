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
estimate: 3                    # story points -> Plane's integer `point`
assignee: someone@example.com  # resolved by email to a project member
status: Backlog                # must match a state name in the project
blocked_by: [PROJ-12]          # these identifiers block this story
blocks: [PROJ-20]              # this story blocks these identifiers
relates_to: [PROJ-30]          # symmetric, non-directional links
```

<description in markdown — rendered to HTML in Plane>

**Effort:** 2.5 dev-days       # developer-days (decimals ok); body line is source of truth
**Depends on:** PROJ-12        # input sugar for blocked_by
**Blocks:** PROJ-20            # input sugar for blocks

### Acceptance Criteria
- [ ] concrete, testable criterion
- [ ] another one
```

**Developer-day effort.** Plane's `point` is integer-only (verified), so decimal effort can't ride on it.
Write `**Effort:** N.n dev-days` as a body line (before the criteria); it lives in the description and
round-trips faithfully. `effort_days:` in the YAML block is accepted as an alternative input — planestories
materializes the body line and `export` re-emits it. `estimate` (story points) is kept separate and
untouched.

**Dependency relations.** Use `blocked_by`, `blocks`, and `relates_to` in story YAML. The
`**Depends on:** PROJ-12, PROJ-13` and `**Blocks:** PROJ-20` body lines are equivalent input sugar for
the two directional fields (and are removed from the description during parsing). To remove a relation,
re-import both endpoints—normally the full project story set—with the relation deleted from the files.
A single-file import is add-only for relations because the omitted endpoint's declarations are unknown.
Planestories will not remove a relation to a non-planestories item or any relation whose endpoint is
outside the current import; those links are one-way and must be removed in Plane or by importing both
managed endpoints.

A single file can hold many stories (each `## ` heading is one). Frontmatter sets the
default project; per-story overrides are not needed for the project in v1. Start from
`templates/user-story.md`.

## Commands

> Terse version for quick lookup: [`CHEATSHEET.md`](./CHEATSHEET.md).


Run all of these from inside the planestories repo:

```bash
export PATH="$HOME/.bun/bin:$PATH"

# Faithful preview — reads the board read-only, reports exactly what apply would do
# (would create / would update / unchanged / would skip a duplicate), makes NO writes:
# Would-update entries include canonical-markdown field diffs; add --no-diff to suppress them.
bun run src/cli/index.ts import /path/to/stories.md --dry-run

# Also validate that status/assignee/label/parent resolve (adds read-only checks):
bun run src/cli/index.ts import /path/to/stories.md --dry-run --check

# Create/update work items and write plane_id/plane_identifier/plane_url back into the file:
bun run src/cli/index.ts import /path/to/stories.md

#   --create-labels   create labels that don't exist instead of skipping them
#   --sync-criteria   DEPRECATED (legacy): one Plane sub-item per criterion. The DEFAULT now keeps
#                     criteria as an interactive TipTap task-list in the parent's description (no
#                     sub-items) — prefer it; run `migrate-criteria` to fold existing sub-items.
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
#   Criteria are recovered DESCRIPTION-FIRST: a description task-list is authoritative; a legacy
#   parent with only `::ac<n>` sub-items still folds them into the story's checklist. Ticking a box
#   in the Plane UI then re-exporting yields `- [x]` — this is the board->file reverse sync.

# Migrate legacy `::ac<n>` criterion sub-items -> a task-list in the parent description, then close
# the children (BOARD-ONLY). Idempotent; dry-run by default. THIS is how you collapse a board that
# used --sync-criteria (on the DATA board that was 71% of all work items).
bun run src/cli/index.ts migrate-criteria --project "My Project"                    # dry-run report
bun run src/cli/index.ts migrate-criteria --project "My Project" --yes              # apply
#   --limit N   migrate at most N parents this run (rate-limit batching; --limit advances across runs)
# A duplicate `::ac<n>` index (stale rename) is reported + skipped, never guessed.
# Safe sequence:  migrate-criteria --yes  ->  export (regenerates files from the migrated board)  ->
# import (a warm no-op). Importing a STALE pre-migration file first would overwrite the migrated board.

# Groom a project: close orphaned criterion sub-items (parent Done), report rot.
bun run src/cli/index.ts groom --project "My Project"          # dry-run report
bun run src/cli/index.ts groom --project "My Project" --yes    # apply (close sub-items)

# Reverse-sync criterion done-state board -> file, in place (ticks/unticks - [x]).
# --write-back is a focused file-only mode: it makes NO board writes.
bun run src/cli/index.ts groom --write-back stories/*.md          # dry-run diff
bun run src/cli/index.ts groom --write-back stories/*.md --yes    # write the boxes

# Lint: offline mechanical pre-import check (no API); exits non-zero on violations.
bun run src/cli/index.ts lint stories/*.md              # strict by default
bun run src/cli/index.ts lint stories/*.md --warn-only  # report only, exit 0
#   Rules (cross-file aware): non-epic story missing AC or effort; epic missing
#   "### Why is this needed?" or carrying AC; dependency cycle/self-ref; dangling
#   reference (warning — may exist on the board); duplicate identifier; orphan
#   criterion; parent not an epic.
#   Complements doctor (board-side) and /rate-userstories (LLM), does not duplicate them.
#
#   Repo conventions: drop a .planestories.yml at your repo root (discovered upward
#   from cwd) so CI/authoring need no flags — a present-but-invalid file fails loudly:
#     lint:
#       strictness: warn        # default lint mode (error = fail on findings, the default)
#       disable:                # rules this repo doesn't enforce yet
#         - missing-effort
#   The --warn-only flag always wins over strictness; disabled rules are printed, never
#   silently dropped.

# Doctor: read-only CI check; exits non-zero on findings (board rot). Checks orphaned/
# parentless criterion sub-items, duplicate titles, and DANGLING dependency relations
# (a blocked_by/blocks/relates_to whose target work item was deleted / left the project).
bun run src/cli/index.ts doctor --project "My Project" --house-rules

# Read-only deployment facts: edition/version, selected dialect, relations, PQL, count endpoint.
# Negatives and failed/inconclusive probes are distinct; add --json for machine-readable output.
bun run src/cli/index.ts capabilities --context ce

# Replicate: take a dated, self-checked backup and retain the newest 14 files.
bun run src/cli/index.ts replicate backup --from cloud -p "My Project" --dir backups --retain 14

# Atlas: render the interactive, self-contained offline "Cockpit" HTML map — status as a
# terraforming ladder (rock/ice/Mars/Earth/cinder), planet size = dev-day effort, per-cluster
# nebula LOD, dependency supply lanes, SCAN/intercept search, epic dossier (docs/ATLAS.md).
bun run src/cli/index.ts atlas /path/to/stories.md  --open   # from a file (no creds)
bun run src/cli/index.ts atlas --project "My Project"         # from the live board
bun run src/cli/index.ts atlas --project "My Project" --no-dependencies    # fast: skip supply lanes

# Packet: emit a self-contained implementable brief for a coding agent from a board
# ticket — description, acceptance criteria (board state), dependencies WITH their
# current status, effort, parent epic, planning refs, + a machine-readable YAML header.
# An epic emits itself + every DESCENDANT's brief (nested epics included) and sums descendant dev-days. Read-only.
bun run src/cli/index.ts packet DATA-123                     # to stdout (pipe to an agent)
bun run src/cli/index.ts packet DATA-1 -o epic-packet.md     # an epic + its whole subtree, to a file

# Epic rollup: a concise summary of an epic — story status breakdown, completion %
# (cancelled stories excluded from the denominator), total effort (with a count of
# unestimated stories), and which stories are blocked / blocking. Read-only.
bun run src/cli/index.ts epic DATA-1

# Contexts / instance profiles: --context <name> selects a named Plane instance.
# A context lives in the config file OR purely in env as PLANE_CTX_<NAME>_API_KEY /
# _WORKSPACE_SLUG / _BASE_URL / _DIALECT (e.g. PLANE_CTX_CE_* for a self-hosted CE). Bare
# PLANE_API_KEY/... apply ONLY when no --context is given — a named context never
# falls back to the bare vars, so dual-instance work cannot cross credentials.
# Leave dialect absent to auto-detect it once per context with a bounded read-only probe.
# PLANE_CTX_CE_DIALECT=work-items is an explicit override and always wins; an inconclusive
# probe warns and falls back to issues. Invalid present values fail configuration loading.

# Discover the workspace's projects (identifier + name) — use either with --project:
bun run src/cli/index.ts projects

# Move a card's state without editing YAML (optionally attach an evidence note):
bun run src/cli/index.ts set PROJ-12 --status "In Progress" --project "My Project"
#   --evidence "deployed abc123; p95 200ms -> 80ms"  append an idempotent, append-only
#     evidence comment (commit SHA / metric before→after). Re-running with the SAME text is
#     a no-op (deduped by a content-hash marker); different text appends a new comment.
#     Works with or without --status (evidence-only is allowed).

# The dependency floor: the longest chain of blocking work, in dev-days, plus each
# item's slack and the biggest lever. Refuses (rather than guessing) on a cycle or an
# incomplete relation sweep, and reports "at least N" when connected work is unestimated:
bun run src/cli/index.ts critical-path /path/to/stories.md
bun run src/cli/index.ts critical-path --project "My Project" --json

# Board health over time, from a directory of snapshots — offline, zero API calls:
bun run src/cli/index.ts trend --dir backups

# What structurally changed between two snapshots (dependencies, epics, status, effort).
# Keyed on the HUMAN identifier, so comparing two instances is not "everything recreated":
bun run src/cli/index.ts diff before.snapshot.json after.snapshot.json

# Clean up test items — scoped + safe (dry-run, then --yes to confirm):
bun run src/cli/index.ts delete /path/to/stories.md --dry-run
bun run src/cli/index.ts delete /path/to/stories.md --yes               # by the file's plane_ids
bun run src/cli/index.ts delete --external-source --project "My Project" --yes  # all items it created
```

The stories markdown file can live anywhere — pass any path.

## Choosing a Plane installation (contexts)

A config file may define one context per Plane installation. `--context <name>` selects one. When
it is omitted, an optional top-level `defaultContext` applies; failing that, a config with exactly
ONE context uses it; otherwise the command stops and lists the names instead of guessing.

**The bare `PLANE_API_KEY` / `PLANE_WORKSPACE_SLUG` / `PLANE_BASE_URL` variables apply only when no
context is in force at all** — including when the context was selected implicitly. A key left in
the shell for one installation therefore cannot authenticate a command aimed at another. Each
command prints its resolved target first, marked `(implicit)` when you did not name one.

`replicate --from` / `--to` are the exception: they never infer. If the config defines contexts,
they must be named.

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
  loop is served by `groom --write-back` below.)
- **`groom --write-back <files…>`** — the reverse half of the loop: pull each criterion
  sub-item's board **completion** back into the file's `- [x]`/`- [ ]` boxes, **in place**.
  For every story in the file that has a `plane_id`, its criterion children are matched to
  the file's acceptance-criteria checkboxes by the `::ac<n>` positional index and the box is
  ticked (`stateGroup === "completed"`) or unticked to match the board. It preserves the
  authored criterion TEXT, narrative, ordering, and YAML (unlike `export --sync-criteria`,
  which regenerates the whole file from the board). Dry-run by default — it prints a
  per-criterion `[ ] → [x]` diff; pass `--yes` to write. Idempotent: a file already matching
  the board makes no change. A story with no `plane_id` is skipped (counted as `unlinked`);
  a stale link (board item gone) is flagged, not fatal. The project is resolved per story
  (`project:` frontmatter → `--project` → `defaultProject`). This can run alongside the
  normal board-side groom — together they are the full reconcile loop.

## Working through the Plane MCP server (alongside this CLI)

An agent session usually has both: this CLI for authoring and bulk sync, and the Plane MCP
server for quick status flips and comments. Three things about the MCP have cost real time
and are not guessable from its schema.

### ⚠ `action: "update"` takes `state`, NOT `state_id` — and the wrong one fails SILENTLY

```jsonc
// CORRECT
{"action": "update", "project_id": "<uuid>", "workitem_id": "<uuid>", "state": "<state-uuid>"}
// WRONG — returns SUCCESS and changes nothing
{"action": "update", "project_id": "<uuid>", "workitem_id": "<uuid>", "state_id": "<state-uuid>"}
```

`state_id` is the natural guess because it is the name used nearly everywhere else — in REST
responses, in this tool's snapshot schema (`stateId`), and in the older granular MCP tools.
Passing it returns success and the item does not move. This closed three tickets that were
never closed; it was caught only because the session re-read the items afterwards.

**So: after an MCP state change, re-read the item.** That is not paranoia, it is the only
signal — there is no error to catch.

### ⚠ Internal UUIDs do NOT survive replication; identifiers do

After a cutover, `DATA-2114` is still `DATA-2114`, so it is natural to reuse the *other*
UUIDs from a snapshot or from the old instance. They are invalid: states, labels and the
project itself are newly minted on the target. You get
`HTTP 400: state: Invalid pk … object does not exist`. Resolve those ids from the instance
you are talking to, and prefer `retrieve_by_identifier` — it is the one call that takes a
human `DATA-N` and needs no `project_id`. Full explanation: `docs/REPLICATE.md`.

### The server is self-teaching — use it instead of guessing

Send a deliberately bogus argument and it enumerates the valid ones:

```jsonc
{"action": "update", "project_id": "…", "workitem_id": "…", "__bogus__": "x"}
// -> Error: action 'update' does not take: __bogus__. It takes: assignees,
//    description_html, …, state, target_date, type_id, workitem_id.
```

This answers schema questions no cheat-sheet can anticipate, and it is the recommended way
to discover an action's parameters. **But note the asymmetry, because it is exactly what
makes the `state_id` bug so nasty: the server rejects a MISSPELLED key loudly and drops a
PLAUSIBLE one silently.** Loud on nonsense, silent on near-misses. The bogus-argument trick
tells you what an action accepts; it will not tell you that the sensible-looking key you
just sent was ignored.

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
- Dependency-cycle checks inspect imported stories plus each directly referenced cross-file target.
  A cycle through multiple consecutive non-imported items may not be visible to planestories; Plane's
  own relation guard remains the final backstop.

## Optional: you're doing a shakedown / test run

If the operator asked you to evaluate planestories (not just use it), use it for real,
then write concrete feedback — anything broken, confusing, or surprising (error messages,
the markdown format, resolver behavior, idempotency, write-back, export quality, docs
gaps, ergonomics), plus what you'd change if it were your tool. Save the feedback to a
file in the project you're working in (e.g. `external_info/planestories-feedback.md`) and
tell the operator it's ready so they can forward it to the planestories maintainer.
