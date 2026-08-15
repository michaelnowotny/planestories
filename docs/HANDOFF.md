# planestories — maintainer handoff

**Read this first. It is the single entry point.** It replaces four dated handoff documents
(2026-07-17, 2026-07-28, 2026-08-08, 2026-08-10) that were deleted in favour of one canonical,
undated file. Keep it that way: when the state changes, EDIT THIS FILE — do not create
`HANDOFF-<date>.md`. Four stale handoffs each opening with "you are picking up" is exactly the
trap this replaces.

Written 2026-08-15 by the outgoing maintainer (a Claude Code session) for the incoming one
(a Grok Build session). It assumes you have never seen this repository.

---

## 1. What this is, in one minute

**planestories** is a Bun/TypeScript CLI that syncs markdown user stories ↔ [Plane](https://plane.so)
work items, in both directions. It is a fork of *linearstories* (Ijonas Kisselbach / Stacking
Turtles Ltd., MIT), retargeted from Linear to Plane's REST API.

**Why it exists.** Its user is a solo developer building a large market-data platform
(`~/PycharmProjects/finance_csv_importer`) with coding agents. Agents work far better from a
precise, checkable, in-repo spec than from a vague ticket. So: stories live as markdown in the
work repo (agents read and tick them), Plane holds status and discussion (the human's view), and
this CLI keeps the two honest. Everything else the tool does — the dependency atlas, the spec
packets, the board doctor, the replication engine — grew out of that one need.

**Its board.** The production board is a Plane Cloud project **"Data Platform" (identifier
`DATA`)** — ~2,500 work items, 47 epics, ~765 stories. It is the finance team's live board. It is
in active daily use by another agent session. **You do not write to it** (see §3).

**Its state.** Mature and heavily reviewed. `main` is green, 604 tests, and every feature since
July shipped through adversarial external review. The one big pending operation is the
**cutover** (§9) — moving the board off Plane Cloud onto the operator's self-hosted Community
Edition — which is built, rehearsed end-to-end, and waiting on the operator's word.

---

## 2. Orientation: what to read, in order

1. **This file** — state, rules, roadmap, gotchas.
2. **`AGENTS.md`** (repo root) — the architecture map with the reasoning behind each module.
   Dense and accurate; treat it as the second half of this handoff. (`CLAUDE.md` is a pointer
   to it, kept so Claude sessions still find it.)
3. **`docs/REPLICATE.md`** — the operator contract for the replication engine
   (snapshot/apply/verify/relink/freshness/backup). Read before touching `src/replicate/`.
4. **`docs/DESIGN_DECISIONS_tier1.md`** — why effort/relations/lint are built the way they are,
   with rejected alternatives. Read before touching `src/markdown/directives.ts`,
   `src/sync/relations.ts`, `src/lint/`.
5. **`docs/DESIGN_criteria-as-tasklist.md`** — why acceptance criteria are a task list inside the
   parent's description instead of child work items. Read before touching criteria handling.
6. **`docs/DESIGN_atlas-cockpit.md`** + **`docs/ATLAS.md`** — the visualizer's design record and
   reference. Read before touching `src/atlas/`.
7. **`docs/KNOWN_LIMITATIONS.md`** — honest list of things that do not round-trip perfectly.
8. **`docs/USING_WITH_CLAUDE.md`** — the agent-facing command cheat-sheet. Despite the name it is
   agent-agnostic; it is referenced by the finance repo, so it was not renamed.
9. `docs/USER_STORY_FORMAT.md`, `docs/RATE_USERSTORIES.md` — the story file format and the
   story-quality rubric.

Historical requirement sources, fully implemented, both carrying a HISTORICAL banner:
`docs/plan-production-feedback-2026-07.md` (tracked) and
`docs/planestories-improvement-brief-2026-07-28.md` (**gitignored** — the `planestories-*` pattern
keeps forwarded cross-repo briefs out of git, so it is absent from a fresh clone; nothing should
depend on it). Beware that same pattern if you ever add a doc named `planestories-something.md` —
git will silently ignore it.

---

## 3. Non-negotiables

These are operator rules, not preferences. Breaking one is worse than shipping nothing.

1. **Never print, echo, log, cat, or commit credentials.** Real keys live in the gitignored
   `.env` (both a cloud key and a CE key). Reference them as `${VAR}`, never by value. If a
   secret ever reaches a remote, rotate it — scrubbing the working tree is not enough.
2. **The cloud `DATA` board is READ-ONLY for planestories development.** Another agent session
   is actively building on it. Reads (snapshot, atlas, doctor, export, dry-run) are fine and
   encouraged; writes are not yours to make.
3. **Do not start the cutover** (§9) or any of its steps without the operator's explicit,
   in-the-moment signal. Not "it looks ready" — the actual word.
4. **On the CE instance, only touch projects this program created** (`SBOX`, `BLOOMR`, `DATA`,
   and probe projects you create). The operator has other projects there. Do not delete or
   modify them.
5. **Live-test against CE or a sandbox project, never against production.** A destructive test
   pointed at a real target is how you lose a board.
6. **Feature branch per change, including docs.** Merge to `main` only after the gate is green
   and the change has been reviewed (§8).
7. **Never coerce missing/unknown data into a valid-looking value.** No silent `0`, `""`,
   epoch, or `false` for "we don't know". Preserve null, omit the field, or emit an explicit
   note/status. Half this codebase's review findings were variants of this.

---

## 4. Environment and how to run it

```bash
export PATH="$HOME/.bun/bin:$PATH"     # Bun, not Node — required in every shell
cd ~/PycharmProjects/planestories
bun install
bun run src/cli/index.ts --help
```

**Bun auto-loads `.env` from the CURRENT WORKING DIRECTORY.** Always run from the repo root, or
the credentials silently aren't there. This is also why the backup cron does `cd` first.

**Two Plane instances, addressed by "context":**

| Target | How to address it | Notes |
|---|---|---|
| Plane Cloud (production `DATA` board) | no `--context` (bare `PLANE_*` env), or `--context cloud` | read-only for you |
| Self-hosted Community Edition | `--context ce` | workspace `archimedes`, `plane.porcupine.works` |

Env-var naming: bare `PLANE_API_KEY` / `PLANE_WORKSPACE_SLUG` / `PLANE_BASE_URL` / `PLANE_DIALECT`
apply **only** when no `--context` is given. A named context reads **only**
`PLANE_CTX_<NAME>_API_KEY` etc. — it never falls back to the bare vars. That isolation is
deliberate: a `--from cloud --to ce` command must not be able to cross its credentials.

**Dialect** (`PLANE_CTX_CE_DIALECT=work-items` is already set): Plane moved its REST paths from
`/issues/` to `/work-items/`. Cloud still serves both; the operator's CE serves **relations only
under `/work-items/`** and 404s them under `/issues/`. Every command threads a dialect; replicate
additionally *detects* it (write-probe for targets, read-only detection for sources).

**The gate** — must be green before any commit:

```bash
bunx biome check --write . && bunx tsc --noEmit && bun test
```

Biome formats with **tabs**, line width 100, and organizes imports. Note for editing tools: when
a patch fails to match on leading whitespace, match an inner substring and let `biome --write`
reindent, or rewrite the file.

---

## 5. The command surface

| Command | What it does |
|---|---|
| `import <files>` | file → board. Create/update/skip-unchanged (content hash), duplicate guard, relations, criteria, write-back of `plane_id`/`plane_identifier`/`plane_url`/`plane_hash`. `--dry-run` (with field-level diff), `--check`, `--status-only`, `--force`, `--adopt-duplicates`, `--force-create`, `--strict`, `--no-diff`. |
| `export` | board → file. Full story blocks incl. warm `plane_hash`; `--orphans-only` emits the parentless-story worksheet; `--open-only`/`--status`. |
| `set` / `delete` / `projects` | small verbs: status flip, scoped delete, list projects. |
| `groom` | closes orphaned acceptance-criterion sub-items whose parent is done. Dry-run default. |
| `doctor` | read-only board-rot report + CI gate (non-zero exit on findings). `--json`, `--no-fail-on-findings`, `--house-rules`. |
| `lint` | offline, mechanical story-file check. No API, no credentials. |
| `atlas` | renders the board as a self-contained offline HTML "cockpit" (force-directed star map). `--json` emits the same graph as data. |
| `packet <ID>` | builds a self-contained implementable spec packet for an item (or an epic + all descendants) — the artifact you hand an agent. |
| `epic <ID>` | epic rollup: status breakdown, completion %, Σ effort, blocked/blocking leaves. |
| `migrate-criteria` | folds legacy `::ac<n>` child items into the parent's description task list. Dry-run default, `--only` canary, `--json`. |
| `rename-project` | single-project rename, dry-run default. |
| `replicate snapshot\|apply\|verify\|relink\|freshness\|backup` | the replication engine (§6). |

---

## 6. The replication engine (the crown jewel — understand this before changing it)

Full contract: `docs/REPLICATE.md`. The essentials:

**`snapshot`** does the one expensive paced read of a project (items incl. archived, relations,
comments, states, labels, members, the sequence map with its gaps, source dialect) into a
versioned, digest-bound, deterministically-ordered JSON file. It is fail-hard: any read failure
aborts and no file is written. That file doubles as a **board backup**.

**`apply`** runs the entire phased writer FROM THE FILE — zero source reads. Dry-run by default.
Phases: probe → target shell (project/states/labels) → items → parents → relations → comments →
verify → placeholder cleanup. Crash-safe via an fsync'd append-only JSONL journal; `--yes` to
write, resume is automatic, `--recreate-target` is the recovery path.

**Exact identifier preservation** is the hard trick and the reason the engine exists. Plane
assigns `sequence_id = MAX(ledger)+1` under a per-project advisory lock, and **retains ledger
rows for deleted items — numbers are never reused** (verified empirically on both instances).
So `DATA-2461` can be reproduced on a fresh instance only by creating items strictly serially in
ascending order, creating throwaway **placeholders** to consume the gaps left by past deletions,
asserting the returned sequence after every single create, and deleting the placeholders at the
end. Preconditions: the target project must be **sequence-pristine** (created by the run itself
— a project that ever held items has a poisoned ledger) and no concurrent writes during the item
phase (a stolen number is unrecoverable; the run aborts and `--recreate-target` rebuilds).

**`verify`** is the cutover gate: journal-anchored (it judges by the run's own recorded mappings,
never by live guesswork), field-complete, bidirectional set equality, normalized-DOM description
comparison with a markdown-tier fallback that downgrades formatting-only differences to warnings.

**`freshness`** answers "did the source change since the snapshot?". Item-level costs 2 list
calls; `--deep` compares per-item comments and relation sets, because **comment/relation edits do
not necessarily bump the item's `updated_at`** — item-level is blind to them and says so in its
output.

**`backup`** = dated snapshot + item-level tear self-check + retention pruning; the nightly cron
(§7) runs it. A stale self-check keeps the file and exits 0 — a slightly-torn backup beats no
backup, and the next night self-heals.

---

## 7. State of the world (2026-08-15)

- **Repo:** `~/PycharmProjects/planestories`, `main` @ `91851cb`, pushed, clean, 604 tests green.
  No open branches, no worktrees.
- **Version discrepancy (known, deliberate):** `package.json` and `src/cli/index.ts` both say
  `0.3.1`, the last npm publish. `main` is far ahead. The release is a planned task (§9.2), not
  an oversight — do not "fix" the version in an unrelated change.
- **CE instance** (`plane.porcupine.works`, workspace `archimedes`) holds: `SBOX` (sandbox),
  `BLOOMR` (small rehearsal replica), `DATA` (a full, exact 2,504-item replica from the
  2026-08-10 rehearsal — **now stale**, superseded by ongoing cloud work; the cutover starts
  from a fresh snapshot, so do not fold or build on this replica).
- **Durable artifacts** in `~/plane-replication/` (outside the repo — contains real board
  content, keep it out of git): the 2026-08-10 rehearsal snapshot + its apply journal + verify
  reports, `tools/cdp_shoot.ts` (the atlas screenshot rig), `backups/`, and
  `data-atlas-2026-08-13.html`.
- **Nightly backup cron is live** on the dev box: user crontab, marker
  `# planestories-nightly-backup`, 04:17 daily, `replicate backup --from cloud -p "Data
  Platform" --dir ~/plane-replication/backups --retain 14`, appending to `backups/backup.log`.
  Its first run correctly reported STALE (the finance session created an item mid-read) and kept
  the file — that is the designed behaviour, not a bug. **At cutover, flip `--from cloud` to
  `--from ce`.**
- **Recently shipped** (all double-reviewed, all with regression tests): the replication engine
  (P2 core, P3 cutover tooling, P4 live matrix, DATA→CE acceptance rehearsal), the Atlas
  cockpit, criteria-as-task-list + `migrate-criteria`, `packet`/`epic`, dependency + effort
  conventions, `replicate backup`, `doctor --house-rules`, `import --dry-run` field diff.

---

## 8. How work gets done here

**Branch, build, prove, review, merge.**

- **Feature branch per change** (docs included). Work in a **git worktree** if anything else
  might touch the main tree — the finance session occasionally does transient checkouts there.
  One agent process per worktree, always: two builders editing one tree produced duplicated
  logic and a wasted review round (§11).
- **Regression-test-first for bug fixes.** Write the test that proves the bug, RUN IT AGAINST
  THE UNFIXED CODE and see it fail (red), then fix and see it pass (green), and keep it. A test
  authored after the fix that never failed proves nothing. Report the red→green sequence.
- **Adversarial external review before merge.** Every substantive change in this repo's recent
  history was reviewed by two independent engines, and **every single round found something
  real** — including six consecutive rounds on a feature that looked finished after two. Expect
  BLOCKs; they are the process working. Now that you (Grok) are the builder, the natural
  reviewer is **Codex**, via the finance repo's helper:

  ```bash
  ~/PycharmProjects/finance_csv_importer/scripts/external_review.sh codex \
      <worktree> <brief-file> <report-file>
  ```

  Write the brief so a reviewer with no context can judge: what changed, why, what to scrutinize,
  what the gate says, and an explicit note that its sandbox is read-only (filesystem tests fail
  there with `EROFS` — those are not findings). Ask for a verdict line: `VERDICT: APPROVE` or
  `VERDICT: BLOCK`. Reviewing your own work is weaker than being reviewed; don't skip this
  because you are confident.
- **Merge discipline:** `git fetch origin`, confirm `main` has not moved, rebase your branch onto
  it, re-run the gate, then **fast-forward** merge and push. A merge that isn't a fast-forward
  from a freshly-verified base is how a phantom revert happens.
- **Commit messages:** subject line, then a body that says what changed and *why*, plus the
  review outcome and gate result. `git log` here is a genuine engineering record — keep it that
  way.

---

## 9. The roadmap — the whole arc, in priority order

### 9.1 THE CUTOVER (operator-gated; the reason most of this exists)

**Goal:** move the `DATA` board off Plane Cloud onto the operator's self-hosted CE, preserving
every identifier (`DATA-2461` stays `DATA-2461`), parents, relations, comments, and original
timestamps/authorship. **Why:** cloud rate limits throttle the workflow, the data should be the
operator's, and CE removes per-seat and paid-tier constraints (estimate/relation *definitions*
are 402-paywalled on the cloud workspace).

**Status:** built, and rehearsed end-to-end on 2026-08-10 with a green result — 2,504 items,
sequences 1..2520 including all 16 historical gaps, 2,238 parents, 46 relations, 1,455 comments,
native `created_at`/`created_by`, **verify 0 failures**. The return trip (CE→cloud with exact
ids) is also proven. Nothing is unknown; it is waiting on timing.

**Runbook — execute only on the operator's explicit signal, in this order:**

1. `replicate freshness --from cloud --snapshot <last>.snapshot.json --deep` — expect STALE
   (work has landed since). That is confirmation, not a problem.
2. Take a **fresh** snapshot of a quiet board (~25 min):
   `replicate snapshot --from cloud -p "Data Platform" -o <new>.snapshot.json`.
   The board must be quiet for the duration — the operator arranges this; consistency comes from
   the freeze, not from reconciliation (there is deliberately no delta sync in v1).
3. `replicate apply --to ce --snapshot <new> --assume-gaps-deleted --yes --recreate-target`
   (~2 h; CE PATCH latency dominates the parent/comment phases and arrives in waves — do not
   diagnose a "stall" under 10 minutes).
4. `replicate verify --to ce --snapshot <new>` — **0 failures required**. Then
   `replicate freshness --from cloud --snapshot <new> --deep` — must say FRESH (proves the
   source didn't move during the window).
5. `replicate relink --to ce --snapshot <new> <story dirs>` on the finance repo's markdown
   corpus. **Dry-run first and have the operator review the diff.** Without this every linked
   story file still points at dead cloud UUIDs and the first edited file would PATCH a cloud id
   against CE.
6. Switch the finance repo's `.mcp.json` from the hosted Plane MCP (cloud-tied OAuth) to the
   **open-source stdio server** `makeplane/plane-mcp-server`, with `PLANE_BASE_URL`,
   the CE key, and workspace slug `archimedes`. Pin the exact env-var names against the installed
   release — older releases use `PLANE_API_HOST_URL`.
7. Flip the backup cron's `--from cloud` to `--from ce`.
8. The operator archives or renames the cloud `DATA` project (`rename-project` exists; note that
   renaming a *destination* identifier changes item prefixes while preserving numbers).
9. Hand the finance session the criteria fold (§9.3), which then runs on CE.

### 9.2 npm release 0.5.0

`main` is far ahead of the published `0.3.1`. Do it as one clean change after the cutover:
bump `package.json` **and** the `.version()` string in `src/cli/index.ts` (they must match),
write a CHANGELOG covering v0.4/v0.5 (atlas cockpit, criteria-as-task-list, packet/epic,
replication engine, backup, house-rules, dry-run diff), verify `bun build` and the `bin` entry,
then publish. **Before any public release**, see §9.6 — the README screenshots contain real
board content.

### 9.3 Criteria fold + orphan backfill (runs on CE, after cutover)

The board still carries ~310 parents / ~1,578 legacy `::ac<n>` criterion child items from the
old model. `migrate-criteria` folds them into the parent description's task list. Order:
`migrate-criteria --json` (dry-run, keep as the "before" artifact) → `--only DATA-x,DATA-y`
canary on a handful of long-closed parents → `--yes` → `export` → `import` → `doctor --json` and
assert `criteria.unmigrated == []` and `criteria.dual == []`. Separately, ~214 of 742 stories are
board-orphans (no parent): `export --orphans-only` emits a worksheet where you add `parent:` keys
and re-import. This is the finance session's work, but the tooling is yours to keep correct.

### 9.4 Parked features — with the reasoning, so you can revive them properly

- **Skip warm stories in relation reconciliation.** Built, then **deliberately reverted**. The
  idea: a story whose `plane_hash` matches is unchanged, and the hash covers its relation arrays,
  so it needn't be re-read. The defect: relations may be declared from **either endpoint**. If A
  alone declared `blocked_by: [B]` and the user deletes that line, only A's hash changes; edge
  removal requires **both** endpoints present in the batch (`canRemoveEdge`), so a warm B outside
  the batch makes the edge unremovable — silently breaking the documented "re-import the full
  set removes it" contract. A regression test now pins this. **If you revive it**, the shape that
  works is *passive records*: keep warm stories in the batch as removal-eligible endpoints
  without spending a `getRelations` read on them (their desired edges are already known from the
  file). Do not simply narrow the batch again.
- **`groom` board→file reverse-sync** (ticking a Plane checkbox and having `export` write
  `- [x]`). Mostly **obsoleted**: with criteria-as-task-list the reader recovers `data-checked`,
  so `export` already round-trips checkbox state for migrated parents. What remains is only the
  legacy `::ac` child model, which `migrate-criteria` is retiring anyway. Don't build the old
  design; confirm the new path covers the case first.
- **Journal-less `verify`.** Today verify is journal-anchored, which is a strength (it judges by
  recorded fact, not inference) but means a replica can only be verified with the journal from
  *that* snapshot's apply. A weaker "structural verify" for an orphaned replica is possible;
  design it as an explicitly *lower-confidence* mode with a different verdict word — never let
  it print the same "0 failures" as the real gate.
- **Snapshot diff + gzip, point-in-time restore.** Now that nightly backups exist, a
  `replicate diff <a> <b>` (what changed between two snapshots) is cheap and genuinely useful,
  and gzip would cut the ~5 MB/night footprint. Snapshots are deterministically ordered
  specifically so they diff cleanly — that groundwork is already done.
- **`doctor` house-rule configuration.** `--house-rules` currently hardcodes two lints
  (missing `**Effort:**`; board-side dependency prose without a wired relation). Making the
  rule set configurable needs a deliberate config story: `.planestoriesrc.json` is *repo/file*
  configuration while doctor is a *board* check, and gluing them together is a design decision,
  not a bolt-on. That is why it shipped hardcoded.
- **Decimal estimates.** Blocked upstream: Plane's `point` field rejects non-integers
  (`400 {"point": ["A valid integer is required."]}`, empirically probed), and estimate systems
  are fixed point-scales behind the paid tier. Hence the `**Effort:** N.n dev-days` body-line
  convention, which `parseEffortDays` reads everywhere (packet, epic rollup, atlas sizing). If
  Plane ships a decimal field this becomes a small mapping feature.

### 9.5 CE housekeeping (operator decision)

`BLOOMR` and the stale `DATA` replica on CE are inspectable and disposable. Ask before deleting.

### 9.6 Before open-sourcing

`docs/images/atlas-*.png` in the README are screenshots of the **real** board and show real
project content. Re-shoot them from a synthetic board first. The rig is
`~/plane-replication/tools/cdp_shoot.ts` — and note **why** it exists: headless Chromium's
`--virtual-time-budget` starves the atlas's force-directed layout (it never settles, and a
fit-to-view on degenerate bounds produces absurd zoom), so screenshots must be driven in real
time over the DevTools Protocol.

---

## 10. Load-bearing facts about Plane (empirically verified — each cost real time)

1. **Sequence ledger is max-ever.** Deleted numbers are never reused. Confirmed on both cloud
   and CE, by probe (mid-delete and top-delete). The whole exact-identifier mechanism rests on it.
2. **Two REST dialects.** `/issues/` (legacy, past its announced deprecation) and `/work-items/`.
   The operator's CE serves **relations only** under `/work-items/`. Work-items relation refs come
   back as `{project_id, issue_id}` objects and are normalized on read.
3. **Neither instance serves the archived-items endpoint.** `verify` therefore has a live-only
   mode that warns explicitly rather than pretending to full coverage.
4. **`created_at` / `created_by` ARE settable** on create — for work items *and* comments — on
   current Plane. Verified live on CE. This is why replicas preserve native timestamps and
   authorship instead of a provenance footer (the footer remains the fallback for unmappable
   authors or older versions).
5. **Comment and relation edits need not bump the parent item's `updated_at`.** Proven from
   Plane's source. This is the entire reason `freshness --deep` exists.
6. **Plane auto-mirrors relations** (A `blocks` B implies B `blocked_by` A). Reconciliation uses
   canonical edge keys so the mirror doesn't double-count.
7. **Plane sanitizes and reparses description HTML on write**, and criteria are a TipTap task
   list (`<ul class="todo-list" data-type="taskList">`, `<li … data-checked="true|false">`).
   Never compare descriptions as raw strings — canonicalize (the codebase has both a normalized-
   DOM comparison and an `htmlToMarkdown` text tier).
8. **CE rejects special characters in project names.** Probe/destination names are plain words.
9. **`point` rejects non-integers**; estimate/relation *definitions* are paid-tier (HTTP 402 on
   the cloud workspace).
10. **Title cap is 255 characters** (Plane's own limit; the fake client enforces it too).
11. **429s are real and bursty.** The client retries transient failures (429/5xx/network,
    honouring `Retry-After`, else exponential backoff with jitter, `PLANE_MAX_RETRIES`). Heavy
    sweeps (atlas, doctor, snapshot) use a paced two-phase fetch — concurrency pass, then a
    sequential retry of failures — and **fail hard** if anything is still missing. That
    fail-hard is deliberate: a partially-fetched export would silently *remove* relations on the
    next import.
12. **The board's API quota is shared with the other session.** A heavy sweep at a busy hour
    gets slow or aborts. Run big reads at quiet hours; an abort here is the design working.

---

## 11. Failure modes already paid for (do not re-learn these)

- **A preview must mirror the writer exactly.** The dry-run field diff took six review rounds,
  and every finding was a variant of one mistake: showing a change apply wouldn't make, or hiding
  one it would. Mirror the *guards* (which fields apply omits), the *resolution* (canonical names
  and member ids, not raw file strings), and the *order of failure checks* (apply fails on an
  unknown parent before it PATCHes, and exits at the duplicate guard before it validates a
  parent). When in doubt, read the apply path line by line and match it.
- **One agent per worktree.** Two concurrent builders on the same tree produced duplicated test
  suites and contradictory edits, and cost a review round. When you background a build, verify
  what is actually running with `pgrep -f <pattern>`; the `$!` of a wrapper script is not the
  agent's pid.
- **`cmd1 && cmd2 & cmd3` backgrounds the whole chain** and loses your variables. It bit this
  project three times. Put multi-step shell work in a script file with absolute paths.
- **Reviewer sandboxes are read-only.** Codex/Grok review runs cannot `mkdtemp`; filesystem tests
  fail there with `EROFS`. Say so in the brief so the reviewer doesn't report it as a finding,
  and give them your own gate result.
- **A "0 dups right now" observation is not a guarantee.** Several near-misses came from
  reasoning about current data instead of about what the code permits.
- **Verify state before asserting it.** Check the branch before committing, the SHA after, and
  re-read a file before claiming its content. Several wasted cycles began with a confident
  statement about a tree that had moved.

---

## 12. Testing

- `bun test` — 604 tests, no network, no credentials. Every test must stay offline.
- **Two fake clients, deliberately separate:**
  - `tests/helpers/fake-plane-client.ts` — for import/export/doctor/groom/sync flows. Records
    calls (assert on them for API-cost regressions), auto-mirrors relations, enforces the title
    cap, resolves PATCHed state ids back to expanded objects.
  - `tests/unit/replicate/fake-plane.ts` — for the replication engine. Stateful projects with a
    **max-ever sequence ledger**, archived items, and a large failure-injection surface
    (ambiguous creates, lost responses, rejected relation kinds, sequence reuse, missing
    endpoints). This is how crash/resume and fail-closed behaviour are proven without a live
    instance.
  - **Adding a `PlaneClient` method means adding it to the relevant fake**, or real-flow tests
    throw.
- Filesystem tests use `mkdtempSync` + cleanup in `afterEach`. Tests that need a CLI process
  spawn `src/cli/index.ts` with `Bun.spawnSync` (the only end-to-end pattern; use it for exit
  codes).
- **Cost regressions are behaviour.** Assert call counts where an accidental per-item loop would
  hurt (e.g. "one label list per project", "the warm path makes zero writes"). Two real defects
  were caught exactly this way.

---

## 13. Where the rest of the history lives

- **`git log`** is the primary record — commit messages here carry reasoning, review outcomes,
  and gate results.
- The four deleted dated handoffs remain in git history if you ever need the play-by-play.
- The replication program's original design authority and the cross-repo request/response briefs
  live in `~/PycharmProjects/finance_csv_importer/external_info/planestories-*.md`. **Those files
  are gitignored in that repo** — they are not part of any repository and could vanish. Every
  durable conclusion from them has been folded into this file, `docs/REPLICATE.md`, and the
  DESIGN docs; treat them as archaeology, not as a dependency.
- The operator communicates cross-repo work by forwarding file paths between sessions. If you
  need something from the finance side, ask the operator to forward it rather than reading around
  in that repo.

---

## 14. If you only remember five things

1. Don't write to the cloud `DATA` board, and don't start the cutover without the word.
2. Never print or commit a credential.
3. Branch, red-green, get reviewed by an engine that didn't write the code, rebase, fast-forward.
4. A preview, a verifier, or a report must never claim more certainty than it has — mirror the
   writer, keep absence explicit, and prefer an honest warning to a confident number.
5. When something looks like a two-line optimization, check whether a contract depends on the
   behaviour you're removing. That is what the reverted relation-batch narrowing was.
