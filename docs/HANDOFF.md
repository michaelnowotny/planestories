# planestories — maintainer handoff

**Read this first. It is the single entry point.** It replaces four dated handoff documents
(2026-07-17, 2026-07-28, 2026-08-08, 2026-08-10) that were deleted in favour of one canonical,
undated file. Keep it that way: when the state changes, EDIT THIS FILE — do not create
`HANDOFF-<date>.md`. Four stale handoffs each opening with "you are picking up" is exactly the
trap this replaces.

Written 2026-08-15 by the outgoing maintainer (a Claude Code session) for the incoming one
(a Grok Build session). It assumes you have never seen this repository.

---

## 0. WHERE YOU WORK (read before your first command)

**This project lives at `/home/michaelnowotny/PycharmProjects/planestories`. Every command, edit,
`git add`, and `git commit` happens THERE.** Run `pwd` before your first git operation and after
any `cd`.

There is a second repository on this machine, `/home/michaelnowotny/PycharmProjects/finance_csv_importer`
(the "finance repo" / market-data platform). **It is not yours.** It is another agent session's
active workspace, with its own uncommitted work in progress. A commit made there lands in someone
else's branch and their review flow. You touch it for exactly two read-only reasons:

1. **Running external reviews:** `~/PycharmProjects/finance_csv_importer/scripts/external_review.sh`
   (invoke it by absolute path — do NOT `cd` into that repo to run it).
2. **The story corpus, during a cutover relink only** (§9.1 step 6), and only on paths the operator
   confirms.

Nothing else. Never `git commit`, `git add`, `git checkout`, or `git stash` in the finance repo.

Two practical consequences of the working directory:
- **Bun loads `.env` from the CWD**, so a command run from anywhere but the planestories root
  silently has no credentials (or, worse, someone else's).
- **`git status` is per-repo.** If a diff you expect is missing, check `pwd` before concluding
  anything about the code.

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
`DATA`)** — 2,548 work items on 2026-08-15: 47 epics, 768 stories, and 1,733 legacy criterion
children awaiting the fold (§9.3). It is the finance team's live board, in active daily use by
another agent session. **You do not write to it** (see §3).

**Its state.** Mature and heavily reviewed. `main` is green, 604 tests, and every feature since
July shipped through adversarial external review. The one big pending operation is the
**cutover** (§9) — moving the board off Plane Cloud onto the operator's self-hosted Community
Edition — which is built, rehearsed end-to-end, and waiting on the operator's word.

---

## 2. Orientation: what to read, in order

1. **This file** — state, rules, roadmap, gotchas.
2. **`AGENTS.md`** (repo root) — the architecture map with the reasoning behind each module.
   Dense and code-shaped; treat it as the second half of this handoff. It is the durable
   architecture record — state and roadmap live HERE, never there, so the two cannot drift.
   (`CLAUDE.md` is a pointer to it, kept so Claude sessions still find it.)
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
| `groom` | closes orphaned acceptance-criterion sub-items whose parent is done. Dry-run default. `--write-back <files>` is a separate, EXCLUSIVE file-only mode: it ticks legacy `::ac<n>`-backed checkboxes in place from board state (no board writes). |
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

**`snapshot`** does the one expensive paced read of a project (items, relations, comments, states,
labels, members, the sequence map with its gaps, source dialect) into a versioned, digest-bound,
deterministically-ordered JSON file. It is fail-hard: any read failure aborts and no file is
written. That file doubles as a **board backup**. Archived items are included *when the instance
serves the archived-items endpoint*; **neither of our instances does**, so in practice the
snapshot records `archivedInventory: "unavailable"` and downstream checks narrow their scope and
say so rather than pretending to full coverage.

**`apply`** runs the entire phased writer FROM THE FILE — zero source reads. Dry-run by default.
Phases, in this exact order (`src/replicate/apply.ts`): probe → gate → target shell
(project/states/labels) → items → parents → relations → comments → **placeholder cleanup** →
**light verify**. Note the order: cleanup precedes verification, and that final step is a *light*
in-run check (id containment + journal-keyed membership) — **not** the `replicate verify` command,
which is the real cutover gate and runs separately. Crash-safe via an fsync'd append-only JSONL
journal; `--yes` to write, resume is automatic.

**`--recreate-target` is narrower than it sounds.** It rebuilds a target project **owned by this
snapshot's journal**. It will NOT delete a project the journal doesn't own: the pre-write gate
(`src/replicate/gate.ts`) fails closed with *"already held by project … the journal does not own
it"*. Removing a foreign or previous-rehearsal project is a deliberate operator step, never a flag.

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

- **Repo:** `~/PycharmProjects/planestories`, `main` @ `97e423a` at the time of writing, pushed,
  **675 tests green**. No known unmerged implementation work, no worktrees, no open branches. (Branch/worktree state is volatile —
  check `git status`, `git branch`, `git worktree list` rather than trusting this line.)
- **Version discrepancy (known, deliberate):** `package.json` and `src/cli/index.ts` both say
  `0.3.1`, the last npm publish. `main` is far ahead. The release is a planned task (§9.2), not
  an oversight — do not "fix" the version in an unrelated change.
- **⚠ THE CUTOVER HAPPENED (2026-08-16). CE is authoritative in practice.** The finance session
  ran the migration: 2,551 items, digest `3051b700233a`, 16 gaps reproduced, **verify 0 failures**,
  relink committed (51 files, 858 substitutions), 1,613 criteria folded on CE, and new tickets
  (DATA-2568…2574) authored directly on CE. **CE and cloud have genuinely diverged — a cloud→CE
  replication would now DESTROY the fold and the new tickets. That path is closed.** **The cutover COMPLETED on 2026-08-16/17:** the MCP is switched (via a wrapper script —
  see below), the nightly cron now snapshots CE into `backups-ce/`, and the cloud project has been
  renamed `DATAX` to break the shared `DATA-N` identifier space. Cloud remains live, unarchived,
  as the rollback. The full
  question-and-answer record is `finance_csv_importer/external_info/planestories-cutover-*.md`
  (gitignored there — the durable version of everything that concerns this repo is §9.5b).
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

## 8b. What shipped 2026-08-16/17 (the first week of real use, and the night after)

The finance session ran the cutover and used the tool in anger; their report drove all of this.
Everything below is on `main`, each item reviewed and each fix carrying a regression test proven
red first. Ordered as the roadmap sections that produced them.

| Shipped | Where it came from | Section |
|---|---|---|
| **Per-instance rate profile** — `apiRateLimit: "60/minute"` mirroring Plane's `API_KEY_RATE_LIMIT`; a token bucket paces to it and concurrency is DERIVED via Little's Law (`λ = R·H/60`, `N = ceil(λ·L)`); AIMD on 429. Opt-in: no profile, no change. | §9.5c #2 | `src/plane/pacer.ts` |
| **`--from-snapshot`** on `doctor`/`atlas`/`export`/`packet`/`epic` — zero API calls, no credentials, works offline. **doctor 0.63 s and atlas 0.72 s** on the 2,558-item board vs live paths that cannot complete at all against a throttled instance. | §9.5c #1 | `src/replicate/snapshot_source.ts`, `src/cli/snapshot_option.ts` |
| **Divergence guard** — `apply` refuses when the destination holds items the snapshot never saw, unless `--allow-divergent-target`. Compares CONTENT, fails closed when it cannot enumerate, and runs BEFORE `--recreate-target` deletes anything. | §9.5c #1 (operator ask) | `src/replicate/gate.ts`, `apply.ts` |
| **Seven real-use bug fixes** — rename false-failure (non-idempotent retry), gate's missing NAME check, archived-path dialect trap, the 45-minute non-exit, `relink` dying on unrelated markdown, `doctor`'s silence, near-invisible label skip. | §9.5b | across |
| **`freshness --quick`** — one request (count + max sequence), 1.3 s, with its blindness stated in its own output. | §9.5b #9 | `freshness.ts` |
| **Source-tagged backups** — `data.<instance>.<stamp>.snapshot.json`; retention prunes only that project from that instance. | §9.5c | `backup.ts` |
| **Snapshot progress + ETA**, and throughput documented as ~30 items/min rather than a wrong fixed figure. | §9.5c #6 | `snapshot.ts` |
| **The exports rule** — board exports default to `exports/` at the REPOSITORY root, gitignored; explicit in-repo paths warn. | operator directive | `src/cli/output_path.ts`, `AGENTS.md` |
| **`snapshot --with-activity`** (2026-08-17) — archives the per-item audit trail so a source instance can be retired without destroying its history. Opt-in, fail-hard, digest-bound, refuses a board-wide empty result, and no schema bump so every existing backup still parses with its original digest. | §9.5d A (operator, deadline-bearing) | `src/replicate/snapshot.ts` |
| **MCP section in the agent cheat-sheet** (2026-08-17) — the silent `state_id` trap, UUIDs that do not survive replication, the bogus-argument discovery trick and its asymmetry. The doc previously had no MCP content at all. | §9.5d B | `docs/USING_WITH_CLAUDE.md` |

**Two behaviour changes downstream users must know**, both relayed to the finance session in
`finance_csv_importer/external_info/planestories-changes-2026-08-17.md`:

1. Poisoned-journal recovery onto a destination holding foreign items now needs BOTH
   `--recreate-target` AND `--allow-divergent-target`.
2. The CLI no longer forces an exit; it prints a linger notice instead (see below).

## 8d. ⚠ WHERE TO PICK UP (2026-08-18) — READ THIS FIRST, IT SUPERSEDES §8c

**State: `feat/critical-path` MERGED to `main` after round 5 returned APPROVE. 770 tests green,
tsc clean.**

Five review rounds; rounds 1-4 all returned BLOCK on real defects. Round 2 found a P0 in code that
had already passed round 1; round 3 found a P0 *introduced by the round-2 fix commit* — an atlas
that never painted. Round 5: no P0, no P1, APPROVE.

### Round 3 (2026-08-18) — every finding addressed, and one of them was severe

**The P0: the atlas never painted.** `c6ef04c`, the commit that fixed the round-2 findings, deleted
`let dragScope,dragAlpha` / `neighbourhoodOf` / `beginDragRelax` / `endDragRelax` along with the
genuinely dead `reheat()`, and left every call site. Under the embedded script's `"use strict"`,
`frame()` is started by `requestAnimationFrame` at load and reads `dragScope` on its FIRST line,
before `draw()` — so the first animation frame threw `ReferenceError`, the canvas stayed blank, and
"ARRANGING…" never cleared. **Every atlas built from `c6ef04c` or `afbf07c` was a dead page**, while
761 tests stayed green, because nothing executes the embedded script and the test that looked like
it covered this asserted that call-site STRINGS existed and that `new Function(script)` parses. An
undeclared binding is valid syntax.

Fixed in `3608c8d`, guarded by `tests/unit/atlas/embedded-script-integrity.test.ts` — which by
`747d011` is TWO general sweeps (every called name declared; nothing assigned that was never
declared), not the hardcoded `dragScope`/`dragAlpha` check it started as. Naming the two bindings
that already bit you cannot catch the third. Its known holes are listed under "Known-open" below.

Also fixed: `--no-dependencies` publishing "nothing blocks anything else" from an unfetched graph
(`c2780e7`); `--json` handing `jq .totalDays` a `0` for an empty chain; the diff banner printing
"DIFFERENT INSTANCES (x vs x)" when only the project differed; atlas `--json` carrying no
completeness flag; and two smaller gaps in the no-estimate set (`dd6e018`).

### What is on the branch

| commit | what |
|---|---|
| `3c82bc1` | `critical-path` — dependency floor, slack, biggest lever |
| `d28469b` | atlas layout SOLVED AT BUILD TIME (the browser used to run 325 settling ticks) |
| `78b6376` | `trend` — board health across nightly snapshots, offline |
| `698a764` | round-1 BLOCK fixes (8 findings, all verified real by round 2) |
| `5959120` | atlas: synchronous settle, scoped drag relaxation |
| `41d1950` | floor gauge, no-estimate flag + filter, `R` removed |
| `999ce1a` | resolved-target announcement (the wrong-instance footgun) |
| `b305313` | `diff` — structural difference between two snapshots |
| `c6ef04c` | round-2 BLOCK fixes (P0 + four P1s) — **also deleted the drag helpers; see above** |
| `6c772a1` | diff/trend board-identity alignment |
| `afbf07c` | handoff §8d |
| `3608c8d` | round-3 P0: restore the drag helpers + the embedded-script guard |
| `c2780e7` | **the structural fix** — dependency coverage is a TYPE, not a comment |
| `dd6e018` | round-3 residual gaps in the no-estimate set |

### ⚠ THE PATTERN THAT KEPT RECURRING — fix the CAUSE, not a fourth instance

FOUR separate reviews found the same shape: **a rule established in one place and not carried to its
siblings.**

1. Relation refs normalized in `snapshot.ts` only — five other consumers silently saw ZERO relations
   on CE (§9.5e).
2. The critical-path floor gained safeguards in the CLI (refuse on partial sweep, no bare
   lower-bound, cycle = refusal) and was then embedded in the atlas HTML with none of them.
3. "Same board" defined as workspace-slug in `diff` and as host+slug+project in `trend`, one commit
   apart.
4. `trend` and `diff` both destructured `{ graph }` from `resolveGraph` and discarded
   `relationFailures` — the field whose own doc comment said callers must decide.

**The common cause: the invariant was written as a COMMENT and relied on memory.** `graph_source.ts`
said *"callers that cannot tolerate a missing edge must say so"* — and `atlas`, `trend` and `diff`
all did not.

**What actually worked, every time it was applied:** making the invariant a TYPE. The discriminated
`CriticalPathResult` (a refusal carries no `totalDays`) has not regressed since it was introduced.
Prose invariants regressed four times.

### The structural fix — DONE in `c2780e7`, and it is the template

`GraphSourceResult` has **no `graph` property**. The graph is reachable only through
`requireCompleteGraph(purpose)` (throws `IncompleteGraphError` unless coverage is complete) or
`acceptPartialGraph(reason)`. `const { graph } = await resolveGraph(...)` — the exact line `trend`
and `diff` were using — no longer compiles.

`DependencyCoverage` is `complete | partial | skipped`, three states rather than a boolean, because
`relationFailures === 0` could not distinguish "we swept and everything succeeded" from "we never
swept" (`--no-dependencies`). The second rendered as a finding about the BOARD. It lives in
`atlas/model.ts`, not `cli/`, because the renderer needs it and a renderer must not import from the
CLI layer.

**Still to do (the other two items from the original recommendation):**
- ONE definition of board identity (`instanceTag(host, slug) + project`), imported everywhere; today
  `trend` and `diff` agree by convention and a comment in each says so.
- Apply rule A11 as a habit, not a one-off: when changing anything shared, ENUMERATE the consumers
  and say in the commit why each does or does not need updating. `c2780e7` does this (six consumers,
  each named); it is what found instance 4 before the review did.

### Known-open, smaller

- **`doctor` declared-vs-actual relation provenance** — the finance session's best request. `doctor`
  already detects dangling relations; what is missing is whether a relation came from a yaml field,
  a body directive, or exists only on the board. Their 2026-08-18 incident is the argument for it.
- **The embedded-script guard is STATIC, and its holes are known.** Two sweeps: every CALLED name
  must be declared, and nothing may be ASSIGNED that was never declared. Together they would have
  caught the round-3 P0 (which was an assignment, a call, AND a first-frame read).

  **Do NOT build the tokenizer** (round-5 ruling). Generalising to all *reads* means telling a regex
  literal from a division; the attempt corrupted the source and invented four phantom findings
  (`RX`, `WRX2`, `RXview`). A guard needing an allowlist of its own ghosts is a test the next person
  disables. The three concrete misses that remain, so nobody rediscovers them:
  1. Delete `const NOEST = new Set()` — its only uses are `.add`/`.has`/`.size`, so neither sweep
     fires and the first frame that builds chips throws.
  2. `++geoTicks` is not an `=`, so deleting `let geoTicks = 0` is invisible to the assignment sweep.
  3. `for (const [child, par] of parentOf)` — the depth-aware scanner records `child`, misses `par`.
     That makes the guard NOISIER (a later `par =` false-positives), not quieter; it matters only if
     the scanner is ever cited as evidence that a name IS declared.

  A DOM+canvas stub is still the only thing that would execute the first frame. Still judged not
  worth it — the failure class it adds (bad property access, wrong arity) has not bitten yet.
- **The atlas crash was never root-caused.** Six hypotheses measured and discarded (§9.5f). The
  animated global settle was REMOVED, which deleted the reproduction. If it resurfaces, that is the
  thread. Residual: `frame()` still ticks a scope per rAF while dragging.
- **Interpenetration on drag**: scoped bodies cannot repel unscoped ones, so an epic dragged onto
  another cluster can overlap it. Accepted knowingly; round 2 flagged it.
- ~~9 pre-existing biome findings~~ **FIXED.** They made step 1 of the documented gate exit
  non-zero on a clean checkout, and because the gate is an `&&` chain, `tsc` and the tests never
  ran — a mandatory rule that could not be satisfied on unmodified code. Seven were auto-fixable;
  two were real (`ProbeClient` declared `listArchivedWorkItems` twice; two assignment-in-expression
  arrow bodies). The gate now passes end to end on `main`.
- `export` has no `announceTarget` (no `loadConfig` call in the same shape).

### The finance session

Their board has a **deleted work item, `DATA-2569`**, with a surviving dangling relation on
`DATA-2570` — verified against a complete 2,588-item list. Answer relayed in
`finance_csv_importer/external_info/planestories-relation-answer-2026-08-18.md`, including that
`**Blocks:**`/`**Depends on:**` BODY LINES ARE PARSED INTO RELATIONS (parser.ts:144) — their
proposed fallback of "keep prose as the record" would have kept generating the relations they were
trying to stop.

## 8c. Where to pick up (as of 2026-08-17)

Nothing is half-finished. Every branch is merged, the tree is clean, and no operation is
mid-flight. Pick by what the operator wants next:

- **⚠ FIRST, and it is an OPERATION not a build: actually RUN the cloud archive.**
  `snapshot --with-activity` shipped 2026-08-17 (§9.5d A has the command), but the audit trail is
  only safe once the file exists. It must happen BEFORE cloud is archived and no later run can
  recover it. Everything else on this roadmap is reversible; this is not.
- ~~The two documentation corrections in §9.5d B~~ — **done 2026-08-17**
  (`docs/USING_WITH_CLAUDE.md` gained an MCP section; it previously had none, which is why the
  guidance the finance session followed lived only in a gitignored brief in their repo).
- **If the operator wants planestories features:** §9.5 (parent-identifier resolution — small,
  self-contained, a real decision to make), then §9.6 (multi-installation default), then the
  unbuilt items in §9.5c (`replicate diff`, `restore-drill`, journal-less verify, attachment
  counts) and the during-run half of §9.5c #6. §9.5a lists the three known residuals, §9.5d D/E
  two small real-use defects.
- **If the operator wants the npm release:** §9.2, and remember the version lives in THREE places.
- **If the finance session asks for something:** they are the primary user; their reports have
  produced the best work in this repo. Their latest brief and my answers are in
  `finance_csv_importer/external_info/planestories-*.md` (gitignored there — the durable version
  of anything that concerns this repo is in THIS file).
- **If something looks broken in production:** the CE board is authoritative and live; cloud is
  renamed `DATAX` and kept as rollback. Read §9.1 for what the cutover did and did not do.

**Planestories work is NOT tracked in Plane.** The DATA board belongs to the finance data-platform
programme; this repo's roadmap lives in this document, deliberately — the tool should not compete
for space on the board it serves. If that ever changes, it is an operator decision, not a
housekeeping one.

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
ids) is also proven.

**What is still open** (be honest with yourself about these before you start): the exact
`makeplane/plane-mcp-server` release and its env-var names must be pinned against what is actually
installed at cutover time (step 7), and the operator must confirm the story-corpus paths (step 6)
and authorize removing the stale CE replica (step 2). The *replication* is a solved problem; the
integration around it has three operator prerequisites.

**Runbook — execute only on the operator's explicit signal, in this order:**

1. `replicate freshness --from cloud --snapshot <last>.snapshot.json --deep` — expect STALE
   (work has landed since). That is confirmation, not a problem.
2. **Clear the destination identifier — an explicit, operator-approved step.** CE already holds a
   `DATA` project from the 2026-08-10 rehearsal. `--recreate-target` will NOT remove it (see §6:
   the gate refuses a project the journal doesn't own), so the fresh apply would fail closed on
   *"already held by project … the journal does not own it"*. With the operator's approval, either
   delete that project in the CE UI, or free the identifier:
   `bun run src/cli/index.ts rename-project --context ce --project DATA --identifier DATAOLD --yes`
   (dry-run first — it prints the change and warns that item prefixes move with the identifier).
   **⚠ Free the NAME as well as the identifier** — the apply also creates the project with the
   snapshot's name, and Plane rejects a duplicate name with a `409 {"name":"The project name is
   already taken"}` that the pre-write gate does not currently catch (§9.5b #1). This bit the real
   cutover:
   `bun run src/cli/index.ts rename-project --context ce --project DATAOLD --name "Data Platform Old" --yes`
   Verify with `bun run src/cli/index.ts projects --context ce` that nothing holds `DATA` or the
   name.
3. Take a **fresh** snapshot of a quiet board (**size it from the item count: ~30 items/min end-to-end; a 2,550-item board took 85 minutes** over a residential link — an early draft of this runbook said ~25 min and that under-estimate contributed to two runs being killed):

   ```bash
   SNAP=~/plane-replication/data-cutover.snapshot.json
   bun run src/cli/index.ts replicate snapshot --from cloud -p "Data Platform" -o "$SNAP"
   ```

   The board must be quiet for the duration — the operator arranges this; consistency comes from
   the freeze, not from reconciliation (there is deliberately no delta sync in v1).
4. `bun run src/cli/index.ts replicate apply --to ce --snapshot "$SNAP" --assume-gaps-deleted --yes`
   (~2 h; CE PATCH latency dominates the parent/comment phases and arrives in waves — do not
   diagnose a "stall" under 10 minutes). Keep the journal it writes: `verify` needs *this* run's
   journal, and no other.
5. `bun run src/cli/index.ts replicate verify --to ce --snapshot "$SNAP"` — **0 failures
   required** (warnings are acceptable and explained in the report). Then
   `bun run src/cli/index.ts replicate freshness --from cloud --snapshot "$SNAP" --deep` — must
   say FRESH (proves the source didn't move during the window).
6. Relink the markdown corpus — **dry-run first, operator reviews the git diff**:

   ```bash
   CORPUS=~/PycharmProjects/finance_csv_importer/planning/stories   # confirm with the operator
   # ⚠ Pass only STORY files. relink parses every .md under a directory and dies on unrelated
   # markdown with invalid YAML — a docker-compose example with duplicate keys killed the real
   # cutover run (§9.5b #2). Scope it:
   FILES=$(grep -rl 'plane_id:' "$CORPUS" --include='*.md')
   bun run src/cli/index.ts replicate relink --to ce --snapshot "$SNAP" $FILES        # dry-run
   bun run src/cli/index.ts replicate relink --to ce --snapshot "$SNAP" --yes $FILES  # apply
   ```

   Without this, every linked story file still points at dead cloud UUIDs and the first edited
   file would PATCH a cloud id against CE.
7. Switch the finance repo's `.mcp.json` from the hosted Plane MCP (cloud-tied OAuth) to the
   **open-source stdio server** `makeplane/plane-mcp-server`, pointed at CE with workspace slug
   `archimedes`. **Unresolved prerequisite:** pin the exact package version and its env-var names
   against the release actually installed — current releases use `PLANE_BASE_URL`, older ones
   `PLANE_API_HOST_URL`, and guessing produces a silently dead MCP. Reference the key as
   `${PLANE_CTX_CE_API_KEY}` (or whatever the operator's launcher supplies) — never inline it.
   Smoke-test by listing projects through the MCP before declaring the switch done; the rollback
   is the previous `.mcp.json`, so keep a copy.
8. Flip the backup cron's `--from cloud` to `--from ce` (`crontab -e`, the line marked
   `# planestories-nightly-backup`), then wait for one run and confirm a CE-sourced file lands.
9. The operator archives or renames the cloud `DATA` project (`rename-project` exists; note that
   renaming a *destination* identifier changes item prefixes while preserving numbers).
10. Hand the finance session the criteria fold (§9.3), which then runs on CE.

### 9.2 npm release 0.5.0

`main` is far ahead of the published `0.3.1`. Do it as one clean change after the cutover.

**The version lives in THREE places and they must match** — miss the third and every snapshot and
journal you write is stamped with a lie:

1. `package.json` `"version"`
2. the `.version("…")` call in `src/cli/index.ts`
3. **`TOOL_VERSION` in `src/constants.ts`** — recorded into snapshots and journals. ✅ `tests/unit/
   version-sync.test.ts` now asserts all three agree (added 2026-08-19), so drift fails the gate
   instead of silently stamping a migration artifact with the wrong provenance.

Then: write a CHANGELOG covering v0.4/v0.5 (atlas cockpit, criteria-as-task-list, packet/epic,
replication engine, backup, house-rules, dry-run diff); run the gate; verify the compiled binary
with `bun run build` (= `bun build src/cli/index.ts --compile --outfile planestories`) and check
the `bin` entry still resolves; `npm publish` (npm auth is interactive — the operator's account
uses WebAuthn, so publishing needs them at the keyboard, it is not automatable from a session);
finally push a `v*` tag, which triggers `.github/workflows/release.yml` to build the
multi-platform binaries and cut the GitHub release. **Before any public release**, see §9.6 — the
README screenshots contain real board content.

### 9.3 Criteria fold + orphan backfill (runs on CE, after cutover)

**Counted from the 2026-08-15 backup** (recount before you start — this drifts; the method is a
few lines of Python over `items[].externalId` in any snapshot): **1,733 legacy `::ac<n>` criterion
children across ~337 parents**, and **226 of 768 stories are board-orphans** (no parent), under
**47 epics**. `migrate-criteria` folds the criterion children into the parent description's task
list.

**⚠ Every command below MUST carry `--context ce`.** Without it the CLI uses the bare cloud
credentials and you would be writing to the production board — the exact thing §3 forbids. This
runs *after* cutover, when CE is authoritative.

```bash
cd ~/PycharmProjects/planestories
P='Data Platform'
# 1. before-artifact (dry-run) — keep it
bun run src/cli/index.ts migrate-criteria --context ce -p "$P" --json > ~/migrate-before.json
# 2. canary: pick 3-5 parents. NOTE the dry-run JSON carries only identifier, title,
#    criteria count and open-child count (no state, no age) — so cross-check candidates
#    in the Plane UI, or pick ones whose openChildren is 0, before choosing. Then:
bun run src/cli/index.ts migrate-criteria --context ce -p "$P" --only DATA-x,DATA-y --yes
# 3. full apply once the canary looks right
bun run src/cli/index.ts migrate-criteria --context ce -p "$P" --yes
# 4. round-trip the corpus and confirm the board is clean
bun run src/cli/index.ts export --context ce -p "$P" -o <corpus-file>.md
bun run src/cli/index.ts import <corpus files> --context ce
bun run src/cli/index.ts doctor --context ce -p "$P" --json > ~/doctor-after.json
```

Gate on `criteria.unmigrated == []` and `criteria.dual == []` in `doctor-after.json`.

For the orphans: `export --context ce -p "$P" --orphans-only -o orphan-worksheet.md` emits a
worksheet whose header lists the epic directory; add a `parent: DATA-N` key to each story's YAML
block, review the diff, then `import orphan-worksheet.md --context ce`. Unknown parents fail that
story's import rather than being guessed.

**Confirm the corpus paths with the operator** (which exported file replaces which of the
finance repo's story files) before writing anything back — the corpus is multi-file and this
handoff cannot know the current layout. This is the finance session's work; the tooling is yours
to keep correct.

### 9.4 Parked features — with the reasoning, so you can revive them properly

- **Skip warm stories in relation reconciliation.** Built, then **deliberately reverted**. The
  idea: a story whose `plane_hash` matches is unchanged, and the hash covers its relation arrays,
  so it needn't be re-read. The defect: relations may be declared from **either endpoint**. If A
  alone declared `blocked_by: [B]` and the user deletes that line, only A's hash changes; edge
  removal requires **both** endpoints present in the batch (`canRemoveEdge`), so a warm B outside
  the batch makes the edge unremovable — silently breaking the documented "re-import the full
  set removes it" contract. The regression that pins it is `tests/unit/sync/importer.test.ts` →
  *"removes an asymmetric dependency when changed A and warm unchanged B are re-imported"*.
  **If you revive it**, the seam already exists in `src/sync/relations.ts`: `syncedIds` (who may
  have edges REMOVED) is deliberately distinct from `relationFetchIds` (whose relations we READ),
  so "passive records" = keep warm stories in `syncedIds`, leave them out of `relationFetchIds`.
  **That alone is not a complete design.** Settle the policy question first: *does a full import
  promise to repair board-side relation drift?* A matching `plane_hash` proves only that the FILE
  is unchanged — it says nothing about what someone did in the Plane UI, so in an all-warm run a
  UI-added or UI-deleted relation would go unseen. Decide explicitly (either "import repairs
  drift, so current relation state must still come from somewhere" or "import is file-
  authoritative and `--force` is the repair path"), write the decision down, and cover four
  cases: changed-A + warm-B removal; all-warm after an out-of-band relation ADD; all-warm after
  an out-of-band relation DELETE; and a cycle involving passive endpoints.
- **`groom --write-back` is SHIPPED, not parked** — an exclusive, file-only mode that ticks a
  story's `- [x]`/`- [ ]` in place to match each legacy `::ac<n>` child's board state
  (`src/sync/writeback.ts`). The open question is its *retirement*: with criteria-as-task-list,
  ordinary `export` already recovers `data-checked`, so once §9.3's fold completes, `--write-back`
  serves only a model that no longer exists. Decide then whether to deprecate it (and say so in
  the docs) rather than carrying a second reverse-sync path forever.
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
  (missing `**Effort:**`; board-side dependency prose without a wired relation). Making the rule
  set configurable needs a deliberate config story, because there are already TWO config files
  with different jobs: `.planestoriesrc.json` (credentials/contexts, gitignored) and
  `.planestories.yml` (committed, non-secret repo conventions — today `lint.strictness` and
  `lint.disable`, read by `src/config/repo_config.ts`). Doctor is a *board* check, so extending
  the *repo* conventions file to configure it is a real design decision, not a bolt-on. That is
  why it shipped hardcoded.
- **Decimal estimates.** Blocked upstream: Plane's `point` field rejects non-integers
  (`400 {"point": ["A valid integer is required."]}`, empirically probed), and estimate systems
  are fixed point-scales behind the paid tier. Hence the `**Effort:** N.n dev-days` body-line
  convention, which `parseEffortDays` reads everywhere (packet, epic rollup, atlas sizing). If
  Plane ships a decimal field this becomes a small mapping feature.

### 9.5 First task, recommended: settle parent-identifier resolution (small, self-contained)

A good warm-up because it is small, has a real decision in it, and touches the test suite.

**The situation.** `docs/DESIGN_DECISIONS_tier1.md` records a deliberate invariant: import resolves
`parent:` EXACTLY (case-sensitive), and lint's parent rules resolve exactly *to mirror it*, while
dependency rules normalize (because relations resolve case-insensitively). Commit `c31fe51` then
wrapped the importer's parent lookup in `normalizeIdentifier`, so import now accepts `eng-7` for
`ENG-7`. That was an unintended side effect of a dry-run-diff fix — the intent was only to stop the
PREVIEW reporting a phantom case difference — and it was not reviewed as a behaviour change.
Consequence today: lint is stricter than import (it can flag a parent import would resolve).
Nothing false-passes, so this is not urgent; it is just a documented contradiction between
required-reading and code, which is exactly the kind of thing that produces a wrong fix later.

**Decide one of two, then make code, lint, atlas, docs, and tests agree:**
- **(A) Restore exactness in the apply path** — revert the normalization at the `parent` lookup in
  `src/sync/importer.ts` (keep it in the diff/preview comparison, which is all that was wanted),
  leaving lint/atlas untouched. Restores the documented invariant; a case-mismatched `parent:`
  fails loudly again. *This is my recommendation* — the invariant was chosen deliberately and the
  drift was accidental.
- **(B) Adopt normalization everywhere** — keep import permissive and normalize lint's parent
  rules and `classifyFileEpics` to match. Friendlier to authors, but `classifyFileEpics` is shared
  with atlas tree assembly and the design doc explicitly says do NOT normalize it, so this option
  is wider than it looks: prove atlas grouping is unchanged.

Either way: a regression test pinning the chosen behaviour for BOTH import and lint on a
case-mismatched parent, and update `DESIGN_DECISIONS_tier1.md` (which currently carries a DRIFT
note pointing here) plus `AGENTS.md`.

### 9.5a Known residuals as of 2026-08-17 (small, none blocking)

Recorded so the next maintainer inherits them as facts rather than surprises:

1. **`SnapshotSource.listWorkItems` hardcodes `assignees: []`** even though a snapshot carries
   `assigneeIds` and `members`, so `atlas`/`export` read from a snapshot show everything as
   unassigned. A real fidelity gap, but NOT destructive: `import` only PATCHes `assignees` when
   the story supplies one, so a snapshot-sourced export cannot clear live assignees. Fix by
   expanding through `members` exactly as state and labels already are.
2. **Ambient `PLANE_*` env is a latent flake source across the suite.** `loadConfig` reads
   `process.env` directly and several suites set `PLANE_*` vars for their own cases; one process
   means those can leak between files. Any NEW test that calls `loadConfig` should
   save/clear/restore `PLANE_*` around each test rather than trust ordering.

   ⚠ **The intermittent failure previously attributed to this was NOT env leakage** — diagnosed and
   fixed 2026-08-19. `loadConfigForSnapshot > a present config file is HONOURED` failed roughly one
   full run in ten with *"Failed to read config file"*. Its `withDir` helper was SYNCHRONOUS while
   every caller passed an `async` body, so `run(dir)` returned a pending promise and `finally`
   deleted the temp directory while `loadConfig` was still reading the file inside it — a
   use-after-free of the fixture, not a leaked variable. `withDir` now awaits. Worth remembering as
   a diagnosis error: the symptom was in the same area as a known hazard, so it was filed under it
   without being reproduced.
3. **Two test-isolation residuals.** `tests/unit/cli/doctor-provenance.test.ts` strips `PLANE_*`
   and uses a temp cwd but does not redirect `HOME`, so a machine with
   `~/.config/planestories/config.json` could boot through a different path. And the `baseUrl`
   assertion in `tests/unit/config/snapshot-config.test.ts` is environmental — the useful pin is
   `baseUrl === ""` under an isolated cwd/HOME/env.
4. **An `isTTY`-gated `process.exit`** remains a candidate for the linger case and is deliberately
   NOT implemented: it is unmeasured, and `src/cli/flush.ts` documents why an unmeasured forced
   exit is not something to bless.

### 9.5b Defects found by the real cutover (2026-08-16) — ALL FIXED 2026-08-17

**Status: every item below is fixed on `main`, each with a regression test proven red against the
unfixed code.** Kept in full because the REASONING is the durable part — each one is a shape of
mistake that can recur in new code, and the fix notes say what the right answer was and why.

The finance session ran the real migration and it landed green (2,551 items, 0 verify failures,
native timestamps/authorship). These are the things that cost them time. Ordered by how likely they
are to bite the next person.

1. **The pre-write gate checks identifier availability but NOT project-name availability.** Freeing
   `DATA` with `rename-project --identifier DATAOLD` left the old project still *named* "Data
   Platform", so the apply died mid-flight on a raw `409 {"name":"The project name is already
   taken"}` from Plane instead of failing closed in the gate where every other precondition is
   checked. Fix: probe the destination NAME too and surface it as a gate error with the remedy.
   Bonus: `rename-project --identifier` could offer/warn about the name.
2. **`relink` crashes on unrelated markdown.** It parses every `.md` in the target tree, so a
   docker-compose example with duplicate `environment:` keys inside an unrelated planning doc
   killed the run (`duplicated mapping key`). Fix: skip files with no `plane_*` fields before
   parsing, and downgrade a YAML error in a non-story file to a warning. Workaround in the docs
   meanwhile: pass only files containing `plane_id`.
3. **A greenfield epic + children file needs THREE import passes**, not the two the docs imply:
   children fail on `parent "…" not found`, then relations fail on unresolved targets. Cause:
   parent and dependency resolution read the MEMOIZED project index, so items created in the same
   run are not resolvable as targets. Fix: invalidate the index after the create phase, or resolve
   parents in a second phase the way relations already are. Until then it is documented.
4. **`migrate-criteria --yes` prints its completion summary and then never exits** (observed 45+
   min, idle CPU). The work IS complete — the action returns straight after `printReport`, so every
   write has been awaited. This is a lingering-handle / process-exit bug, not unfinished work.
   Fix: close the client and exit explicitly on long-running commands. Killing after the summary is
   safe and is now documented as such.
5. **`doctor` against a rate-limited instance produces no output for 10+ minutes and then nothing.**
   It issues one relations GET per non-criterion item (~800 on a big board) and fails hard rather
   than report a partial scan (correct — a partial scan is a false-clean CI gate). Fix: a progress
   indicator, so "slow" is distinguishable from "hung".
6. **New labels are silently skipped without `--create-labels`** (one dim line in a long summary).
   Fix: make the skip loud in the summary. Do NOT default to creating — silent creation from a typo
   is how a board accumulates `ops`, `Ops`, and `opps`.
7. **`rename-project` reports FAILURE after SUCCEEDING** (found 2026-08-16 in real use; the
   dangerous direction, because it invites a destructive retry). Cause: a non-idempotent retry —
   the client replays transient failures, so a PATCH that *applied* but hiccupped in transport is
   re-sent and the replay fails `400 "identifier already in use"` (taken by itself). The handler
   converts any 400/409 into a hard error without checking reality. Fix: on 400/409, re-read the
   project and report success if the desired state is already in place (house rule A10 —
   after an ambiguous write, verify durable state before replaying or reporting).
8. **The archived-items probe follows the DIALECT and so asks for a path that does not exist.**
   The archived list is served only under the `work-items` spelling: on cloud
   `archived-work-items/` returns `200 total_count=0` while `archived-issues/` 404s. A cloud
   snapshot on the `issues` dialect therefore reports "endpoint unavailable" when a definitive
   "nothing archived" was available, and `verify` carries a caveat it does not need. Fix: probe
   the `work-items` spelling regardless of dialect before concluding unavailable. (On instances
   that genuinely lack it — the operator's CE — the caveat is honest and must stay.)
9. **`freshness --quick` (new, small, genuinely useful).** A full `--deep` is unaffordable against
   a rate-limited instance — the finance session could not get any verdict during the cutover.
   Plane's paginated envelope already carries what a cheap check needs; a live CE response shows
   `total_count`, `count`, `total_pages`, `total_results` alongside `next_cursor`, but our
   `PlanePage<T>` type models only `results`/`next_cursor`/`next_page_results` and discards them.
   Build: one request with `per_page=1&order_by=-sequence_id` → compare `total_count` + top
   `sequence_id` against the snapshot. **It cannot see in-place edits**, so it must print a weaker,
   explicitly-caveated verdict — never the same wording as `--deep`.

### 9.5bb What the FIRST WEEK of real use taught us (2026-08-17)

Measured against a live instance while answering the finance session's follow-up. These
supersede several assumptions in the docs, and three of them are the reason for the bug list
in 9.5b.

1. **`completed_at` and `updated_at` cannot be written at all** — not on create, not on PATCH
   (`200 OK`, silently unchanged), and `completed_at` is server-stamped even when you supply it
   while moving an item into a completed state. `created_at` *is* writable, because Plane's
   create view deliberately copies it after save. **The POST response echoes server time**, so
   only a re-read reveals the persisted historical value — any future probe must re-read rather
   than trust the create response. A `completed_at` backfill is therefore impossible; do not
   build one. Full matrix: `docs/REPLICATE.md` §Fidelity.
2. **The archived list exists ONLY under the `work-items` spelling**, and not at all on some
   self-hosted versions. Cloud: `archived-work-items/` → `200`, `archived-issues/` → `404`.
   The operator's CE: both 404. Since the client derives that path from the *dialect*, a cloud
   snapshot on the `issues` dialect wrongly concludes "unavailable" (9.5b #9).
3. **An activity/audit export DOES exist**: `GET .../work-items/{id}/activities/` returns 200
   with `verb`/`field` per entry, both spellings, on cloud. It is per-item, so a full dump is
   ~1 request per item — affordable now that pacing exists. Offered to the finance session as
   `replicate snapshot --with-activity`; not yet built.
4. **Zero embedded images.** A scan of all 2,558 items found no `<img>` and no external asset
   host in any description, so retiring the source instance breaks nothing there. Worth
   re-measuring per board rather than assuming either way — the check is a one-line scan of
   `descriptionHtml`.
5. **Snapshot throughput is ~30 items/min end-to-end** over a residential link (2,550 items =
   85 minutes), not the "~25 min" an early runbook draft claimed. The under-estimate directly
   caused two runs to be killed mid-flight.
6. **The MCP server's tools are action-dispatched** (`workitem` + `action: "list"`), and
   `retrieve_by_identifier` is the one call taking a human `DATA-N` with no `project_id`. The
   `.mcp.json` **wrapper script is the recommended default**, not a fallback: a `${VAR}`
   reference to a mistyped name yields an *empty key* and a silently-dead MCP.

### 9.5e The relation-ref defect (2026-08-17) — FIXED, with three follow-ups still open

**The most instructive bug this project has had, because every layer of defence missed it.**

Reported by the finance session as *"import reports creating dependency relations that do not
persist"*. **Their diagnosis was wrong and the truth was worse.** I queried CE directly: the
relations WERE on the board. The writes had always worked; **the READ was broken**, which produces
an identical symptom ("would create 3" on every re-run) and had far wider consequences.

Cause: Plane returns relation refs as bare STRINGS on `/issues/` and as
`{project_id, issue_id}` OBJECTS on `/work-items/`. `PlaneIssueRelations` types them `string[]`, so
objects flowed through as ids and every lookup key became `[object Object]`. On CE, **no existing
relation was ever visible.**

What that produced, all observed rather than theorised:
- `import` re-created every relation on every run, with the direction depending on batch membership
  — so repeated runs wrote the REVERSED edge and **created a live two-node cycle**
  (DATA-2569 ↔ DATA-2570). The cycle guard could not prevent it: the guard reads the same blind
  edge list.
- **Five consumers were silently wrong on CE** — `relations.ts`, `atlas/model.ts` (live dependency
  graph EMPTY), `packet.ts` (**agents handed the wrong dependencies**), `rollup.ts`,
  `graph_check.ts`. Only `snapshot.ts` normalized, which is exactly why `--from-snapshot` views
  looked correct while live ones did not.

**Fixed** at the client boundary (`9ac1217`) — see §10 fact 2. Three reasons that location:
per-consumer normalization is what caused the bug; a new consumer inherits the fix for free; and
the failure mode of forgetting is *silence*, not an error.

**Why every defence missed it, which is the part worth carrying:**
1. **The type lied.** `string[]` while the wire sometimes returns objects. tsc cannot help when the
   annotation is the thing that is wrong.
2. **No test ever presented the object shape.** Every fake returns strings, so the whole suite
   passed identically before and after the fix. This is a NEW variant of §10b: not a test that
   could not fail, but an INPUT SHAPE no test ever supplied. When an API's response varies by
   configuration, the fakes must cover every variant, or the untested variant is the production one.
3. **The documentation asserted the fix existed.** §10 fact 2 said refs "are normalized on read" —
   true in one file, read as a guarantee.
4. **The dry-run agreed with the apply**, because both compute from the same broken read. A preview
   that mirrors the writer cannot catch a defect they share.

**Still open (queued, in priority order):**
- **The relation count reports INTENT, not outcome.** `created: toCreate.length` is computed before
  any POST is issued, so "Relations created: 3" means "we meant to create 3". It must count verified
  outcomes — and a 2xx is NOT sufficient proof either, because Plane silently drops cycle-creating
  relations, so the honest check is a read-back.
- **`export` omits `blocked_by`/`blocks`.** Relations therefore do not round-trip, and a field
  export omits cannot be used to verify or to detect drift. (The finance session mis-read a missing
  `blocked_by` in an export as evidence a relation had been cleaned up; it was not evidence.)
- **A `doctor` check for "declared dependency not present on the board"** — worth much more now
  that the read is trustworthy.

### 9.5c Product opportunities the real cutover revealed (bigger than defects — read before picking work)

§9.5b lists things that broke. These are things the experience showed are *missing*, ordered by
value-per-effort. The cutover changed the tool's centre of gravity: CE is now primary, it is
~25× faster than cloud for the same work, and a full-fidelity offline snapshot of the board exists
every night. Several long-standing constraints stop making sense in that world.

1. **`--from-snapshot` for every read-only command** (doctor, atlas, export, packet, epic, lint's
   board-side cousins). *The strongest idea here.* A snapshot already contains items, hierarchy,
   relations, comments, states and labels — everything those commands enumerate the API for. Today
   `doctor` costs ~800 relation GETs and simply cannot complete against a rate-limited instance;
   against a snapshot it would be a local computation taking seconds, with zero API calls, and it
   would work offline and on a plane. It also turns the nightly backups into something you *use*
   rather than something you hope never to need, and it makes historical analysis possible
   ("what did the board look like three weeks ago?"). Design note: the command must SAY it read a
   snapshot and print the snapshot's `takenAt`, so nobody mistakes a stale answer for a live one.
2. **DONE — Per-instance performance profiles.** Per-context `apiRateLimit` now mirrors Plane's
   `API_KEY_RATE_LIMIT`; a per-client token bucket paces to it and derives sweep concurrency from
   observed latency via Little's Law, while an absent profile preserves the old constants.
   **Configurable BOTH ways** — `apiRateLimit` in a context's config entry, or the env form
   `PLANE_CTX_<NAME>_API_RATE_LIMIT` (bare `PLANE_API_RATE_LIMIT` on the default path). The env
   form is wired in `src/config/loader.ts:172-178` and pinned by
   `tests/unit/config/rate-profile.test.ts`; a report that it is missing was checked and is wrong
   (§9.5d C) — the confusion came from the *telemetry*, not the *setting*.
3. **`replicate diff <a.snapshot.json> <b.snapshot.json>`.** Snapshots are already
   deterministically ordered *specifically* so they diff cleanly — the groundwork is done. This is
   the missing answer to the situation the cutover created: CE and cloud have genuinely diverged,
   and there is currently no way to see *how*. Also gives point-in-time board archaeology ("what
   changed last week?") and a cheap review artifact. Note what it must NOT pretend to be: a merge
   tool. Show the difference; let a human decide.
4. **`replicate restore-drill`.** The backups are now load-bearing and have never been restored.
   One command should: apply a chosen backup into a scratch project under a throwaway
   `--dest-identifier`, run `verify`, report, and delete the scratch project. Until that exists,
   "we have backups" is a belief rather than a fact. (The operator's other repo runs exactly this
   discipline for its ZFS backups — a periodic restore drill with a timestamp — so the concept is
   already in their mental model.)
5. **One-pass greenfield import.** Authoring a NEW epic + children directly on the board is now a
   primary workflow (it was rare when everything came from cloud). Today it takes three passes
   because parent and dependency resolution read a memoized index that predates the run's own
   creates (§9.5b #3). Fix the index lifecycle and this becomes: write the file, `import`, done.
6. **HALF DONE — Progress + cost telemetry on every paced command.** Print a progress line with an
   ETA, and on completion the API call count and elapsed time. Two payoffs: "no output for ten
   minutes" stops being indistinguishable from a hang, and the *cost* of a command becomes visible
   — which is how you would have known, without measuring by hand, that doctor makes ~800 calls and
   snapshot ~2× the item count.
   **What shipped is the COMPLETION half only**, and the second week showed that is the wrong half
   to have first: `reportPacing` fires after the command finishes, so a run you kill because it
   looks hung prints nothing at all, and a `doctor` whose entire prelude (`groom` +
   `fetchProjectIndex`) is un-instrumented looks dead for minutes on a big board regardless of
   instance speed. See §9.5d C and D — the remaining work is an immediate opening line plus
   during-run cost, not more polish on the sweep counter.
7. **A journal-less structural verify** (already parked in §9.4, now more valuable). Post-cutover
   there is a live CE board and nightly snapshots but no way to ask "is this board still what I
   think it is?" without the original apply journal. Ship it as an explicitly weaker verdict with
   different wording from the real gate.
8. **Instance provenance in story files.** `plane_url` records the host, but `plane_identifier:
   DATA-2461` alone is now ambiguous across two live boards sharing an identifier space. Consider
   stamping the workspace/base-url (or a short instance alias) into exported story blocks and
   packet headers, so a file says which board it belongs to without inference.

### 9.5d Second week of real use — the finance session's report (2026-08-17)

Six items from real usage after the cutover. One is an approved feature with an external deadline;
two are corrections to guidance I gave them that is actively harmful while wrong; one of their
reports is factually wrong, and the reason they reached it is itself the finding.

**A. ✅ SHIPPED 2026-08-17 — `snapshot --with-activity`.** It was the only item here with a
DEADLINE: the operator wants the cloud board's audit trail dumped **before cloud is archived**,
and no later run can recover it.

**To actually run it** (the point of the whole exercise — this is still to do):

```bash
cd ~/PycharmProjects/planestories
bun run src/cli/index.ts replicate snapshot --from cloud -p "Data Platform" \
    -o ~/plane-replication/data-cloud-archive.snapshot.json --with-activity
```

Budget ~2× a normal snapshot: activities add one request per item on top of the existing
relation and comment sweeps. Size it from the measured ~30 items/min baseline and run it at a
quiet hour. It is fail-hard, so a rate-limit storm costs the whole run — that is deliberate
(see below), but it means the hour matters.

Design notes, because "dump the activities" hid four decisions:
- `GET .../work-items/{id}/activities/` is **per item** — ~2,551 requests, both dialect spellings,
  200 on cloud (§9.5bb #3). At cloud's paced rate that is roughly an hour. Affordable *because*
  the pacer shipped (§9.5c #2) — this is that work paying for itself.
- **Opt-in only.** It more than doubles a snapshot's cost; the nightly backup must not silently
  inherit it.
- **Fail hard, and never emit an empty array for an item whose activities could not be read.**
  `snapshot` is fail-hard by design, and an archival dump is exactly the case where a silent gap is
  worst: an empty `activities: []` is indistinguishable from "this item genuinely has no history".
  That is the null-ban in its most consequential form. Shipped as: fail-hard sweep, plus
  `source.activityInventory: "captured" | "not-requested"` so absence is never ambiguous
  (`parseSnapshot` rejects a file where the discriminator and the section disagree).
- **NO schema-version bump** — the reasoning inverted during the build and it matters. `parseSnapshot`
  hard-refuses an unknown version, so bumping would have made **every existing nightly backup**
  unreadable by `apply`/`verify`/`--from-snapshot`. An optional archival section that no consumer
  requires is not a breaking shape change. `activities` is still digest-bound; an ABSENT section
  contributes nothing because `canonicalJson` drops undefined values, so old files keep their exact
  original digests. `tests/…/snapshot.test.ts` pins the pre-change fixture digest `8896e27b…` as the
  tripwire — **that test is SUPPOSED to fail** if anyone changes absent-key handling, because doing
  so would silently invalidate the operator's whole backup history.
- **A board-wide empty result is refused** (added after the review probed `listAll`). `listAll`
  returns `[]` for any envelope it does not recognize, so an unseen response shape degrades to
  silence rather than an error — producing a digest-valid file that looks like a complete archive and
  holds nothing, discovered only after the source is gone. One quiet item is ordinary; a whole
  project with zero entries is a parse failure, so the guard is on the aggregate only.
- **Captured but never replayed**, and the `apply` loss report says so with the real entry count.
  Plane stamps its own activity as a replica is written; a forged audit trail is worse than none.
  (The old grouped "activity not inventoried" loss line became false the moment capture existed —
  a reminder that a schema change is done only when every DERIVED path agrees with it.)

**B. Two MCP cheat-sheet corrections — and we caused the first one.**

1. **`workitem` + `action: "update"` takes `state`, NOT `state_id`.** Passing `state_id` returns
   SUCCESS and silently changes nothing. The finance session closed three tickets, got no error,
   and caught it only because their verification re-read the items in the same session. Without
   that they would have reported three closures that never happened.
   **Why the wrong guess is so natural is the part worth writing down: our own naming taught it.**
   The snapshot schema says `stateId`, and `src/plane/issues.ts:92-93` maps our internal `stateId`
   onto the wire field `state` — so an internal name leaked into their model of the wire API. The
   docs must say plainly: **the wire field is `state`, in both REST and MCP; `stateId` is ours and
   `state_id` is nobody's.** (Our CLI is correct — it has always sent `state`.)
2. **Internal UUIDs are NOT preserved across replication.** Identifiers survive exactly
   (`DATA-2114` is `DATA-2114`), which makes it natural to assume the snapshot's other UUIDs are
   valid on the target. They are not: apply MINTS new state, label and project objects. Using a
   snapshot's state id against CE gives `HTTP 400: state: Invalid pk … object does not exist` —
   loud, so this is a documentation gap rather than a bug. `docs/REPLICATE.md`'s fidelity matrix
   needs the rule stated once: *identifiers are preserved; internal UUIDs are NEW on the target —
   resolve them from the target, never from the snapshot.* Their follow-on suggestion is good and
   cheap: have `verify` emit the state-id mapping, since post-migration scripting needs it and the
   journal already holds both sides.

**C. `PLANE_CTX_<NAME>_API_RATE_LIMIT` IS implemented — and why they concluded otherwise is the
real finding.** Verified before folding this in: `src/config/loader.ts:172-178` parses it, and
`tests/unit/config/rate-profile.test.ts:77` pins that exact variable name (11 tests, green). **Do
NOT downgrade the docs to "config-file only"** — that would document a limitation the code does not
have. What they actually observed is the finding: **`reportPacing` prints only at COMPLETION**
(`src/cli/pacing.ts`), and their `doctor` run never completed — they backgrounded it at 115s. Cost
telemetry that exists only at the end is missing exactly when you most want it, which is while a
command is running long enough that you are wondering what it is doing. §9.5c #6 shipped the
*completion* half; the *during* half is what they needed. Treat that as the item's second half, not
as done.

Their measurement deserves a precise reading: 90 GETs in 36 s with zero 429s proves their CE limit
is **at or above 150/min** — it does not establish its value, because not hitting a ceiling tells
you nothing about where the ceiling is. The instance is theirs, so the authoritative answer is free:
read `API_KEY_RATE_LIMIT` off the CE deployment rather than inferring it from a clean run.

**D. `doctor` is slow on CE too, and its silent PRELUDE is un-instrumented.** Progress exists but
covers only the relation sweep (`src/cli/commands/doctor.ts:109-133`). Everything before it —
`groom` (a full board read), `resolveProject`, and `fetchProjectIndex` across 2,558 items — is
silent by construction, so "no output at all, then backgrounded at 115s" is exactly what the code
does. The fix is not more progress on the sweep; it is an immediate first line (what it is scanning,
against which instance) and instrumentation of the fetch phase. Note the earlier framing was wrong
in a specific way worth remembering: I treated this as a *cloud rate-limit* problem, when it is a
*board-size* problem — 2,558 items is slow on a fast instance too.

**E. `migrate-criteria --only` reports a disjunction it could resolve.** `src/cli/commands/migrate.ts:69`
prints *"ids matching NO migration candidate (typo? no ::ac children? already migrated?)"* — three
cases with opposite meanings, since "already migrated" is success and "typo" is an error. The tool
holds the facts to tell them apart (it knows whether the description carries a checklist and whether
children exist). **This is the null-ban's mirror image:** the standing rule forbids inventing
certainty you lack, and the same principle forbids discarding certainty you have. The finance
session had to verify by hand that a fix had worked.

**F. The MCP server is self-teaching — document the trick deliberately.** Sending a deliberately
bogus argument makes it enumerate the valid ones: `{"action":"update", …, "__bogus__":"x"}` →
*"action 'update' does not take: __bogus__. It takes: assignees, description_html, …, state,
target_date, type_id, workitem_id."* That single trick answers questions a cheat-sheet cannot
anticipate, and it belongs in `docs/USING_WITH_CLAUDE.md` as the recommended way to discover any
action's schema. **The caveat is what makes item B1 so dangerous:** the server rejects a MISSPELLED
key loudly but drops a PLAUSIBLE one silently. Loud on nonsense, silent on near-misses, is the wrong
way round.

### 9.6 Multi-installation ergonomics: a default installation — ✅ BUILT 2026-08-19 (`d6f1e21`)

**Shipped as specified.** `defaultContext` + single-context auto-default; a dangling `defaultContext`
is a startup error; the implicit path keeps full credential isolation (bare `PLANE_*` does not apply
to it) and `announceTarget` marks it `(implicit)`. `replicate` additionally REFUSES to infer an
installation (`allowImplicitContext: false`) — step 4's rule, which needed enforcing rather than
only documenting, since `--from`/`--to` are plain options and the multi-context throw was what had
made them effectively mandatory. The original specification follows, for the reasoning.


**Operator request, 2026-08-15.** The tool already supports multiple Plane installations well —
what it lacks is a sane default. Current facts (verified in `src/config/loader.ts` +
`src/config/schema.ts`):

- **Supported today:** a `.planestoriesrc.json` of the form
  `{"contexts": [{"name": "ce", "apiKey": "…", "workspaceSlug": "archimedes", "baseUrl": "…",
  "dialect": "work-items", "defaultProject": "…"}, {"name": "cloud", …}]}`; selection via
  `--context <name>` (and `--from`/`--to` on `replicate`); per-context env overrides
  `PLANE_CTX_<NAME>_*`; env-only contexts (no file entry needed); and a hard error if two context
  names normalize to the same env prefix.
- **Missing:** there is **no `defaultContext`**, and **no single-context auto-default**. With a
  multi-context config and no `--context`, `loadConfig` throws *"Config file contains multiple
  contexts. Use --context <name>…"* — even when only ONE context is defined. The de-facto default
  is the bare `PLANE_*` env vars, i.e. the default is env-driven rather than config-driven.

**Build this:**
1. Accept an optional top-level `defaultContext: "<name>"` in the multi-context config (validate
   that it names an existing context; a dangling value is a startup error, never a silent
   fallback).
2. Resolution order when `--context` is omitted: explicit `--context` → `defaultContext` → **if
   exactly one context is defined, use it** → otherwise the existing error listing the names.
3. **⚠ The load-bearing safety rule:** when a context is selected *implicitly* (by default or by
   being the only one), the bare `PLANE_*` env vars must **NOT** apply to it — exactly as they
   don't for an explicit `--context`. Otherwise a cloud key in the ambient environment could
   silently authenticate a CE-targeted command. Credential isolation is the whole point of the
   contract in §4; a default must not become a hole in it. Test this explicitly.
4. **Leave `replicate --from/--to` explicit** — no defaulting. A cross-instance migration must
   never silently pick a side; that is a feature, not an omission. Say so in `docs/REPLICATE.md`.
5. Report the resolved installation in command output/`--json` where a user could be confused
   about which board they just hit.

**Naming:** the operator's mental model is "Plane installation"; the code says "context". Keep
`--context` as the canonical flag — it is threaded through every command, documented, and used by
the finance repo's workflows — but consider wording the help text as
`--context <installation>  Plane installation to target (see .planestoriesrc.json)`. If you add
`--installation` as an alias, make it a true alias of one implementation, never a second code path.

### 9.7 CE housekeeping (operator decision)

`BLOOMR` and the stale `DATA` replica on CE are inspectable and disposable. Ask before deleting.

### 9.8 Before open-sourcing

✅ **DONE 2026-08-19 (`10cb4e4`).** `docs/images/atlas-*.png` were screenshots of the real board
showing real project content; they are now shot from a synthetic one. `tools/gen_demo_board.ts`
(committed, deterministic) generates it and `tools/README.md` documents the procedure.

The old rig's reason is **obsolete**: it drove Chromium over the DevTools Protocol in real time
because `--virtual-time-budget` starved the force-directed layout. The layout is solved at build
time now, so the page opens already arranged and an ordinary headless screenshot is correct.

Also still outstanding from an earlier cleanup: **`~/plane access.txt` exists on the dev box** and
looks like a stray credentials/notes file. Ask the operator to delete it (do not open it).

---

## 10. Load-bearing facts about Plane (empirically verified — each cost real time)

*Verified by probe or live run at the dates given in git history. Anything about the CURRENT
contents of an instance (CE project inventory, npm publication state, board counts) is a dated
observation — re-check it, don't trust it.*

1. **Sequence ledger is max-ever.** Deleted numbers are never reused. Confirmed on both cloud
   and CE, by probe (mid-delete and top-delete). The whole exact-identifier mechanism rests on it.
2. **Two REST dialects.** `/issues/` (legacy, past its announced deprecation) and `/work-items/`.
   The operator's CE serves **relations only** under `/work-items/`. **Work-items relation refs
   come back as `{project_id, issue_id}` OBJECTS where `/issues/` returns bare id STRINGS** — and
   `PlaneIssueRelations` declares them `string[]`, so TypeScript will not catch an object flowing
   through as an id. **The live HTTP boundary is `PlaneClient.getRelations`**
   (`src/plane/relation_refs.ts`): it normalizes, so every consumer receives bare ids on every
   dialect, and it fails closed BOTH on an unrecognizable ref and on a non-object payload (a bad
   envelope silently becoming "no relations" was the same defect on a different input — review
   caught it). `compactRelations` in `snapshot.ts` re-checks deliberately: its `SnapshotClient` is
   duck-typed and is not always a real `PlaneClient`, so that is a second guarded ENTRANCE, not a
   duplicate — which is why an earlier draft of this line saying "exactly ONE place" was too
   strong. **Never normalize in a CONSUMER** — the earlier
   version of this line said refs "are normalized on read", which was true only in `snapshot.ts`
   while five other consumers used the raw ref as an id and saw ZERO existing relations on CE
   (§9.5e). A general-sounding claim that holds in one file is worse than no claim at all.
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
    sweeps use a paced two-phase fetch — a concurrency pass, then a sequential retry of the
    failures. **The failure policy then differs by command, deliberately:** `snapshot`, `export`,
    and `doctor` **fail hard** on any residual failure (a partially-fetched export would silently
    *remove* relations on the next import; a partial doctor scan is a false-clean CI gate),
    whereas `atlas` is **fail-soft** — it drops the failed items' edges, warns on stderr, and
    still renders (a graph with most edges beats no graph, and it is a read-only visualizer that
    nothing downstream consumes). Don't "fix" either behaviour into the other.
12. **The board's API quota is shared with the other session.** A heavy sweep at a busy hour
    gets slow or aborts. Run big reads at quiet hours; an abort here is the design working.

---

## 10b. Tests that cannot fail — the dominant failure mode of 2026-08-17

Across eight adversarial review rounds in one night, the single most common defect was **a test
that passed against broken code**. Not sloppy tests — tests that *looked* rigorous and were
reported as evidence. Five real instances, because the shapes repeat:

1. **The wrong layer.** A divergence-guard test exercised `decideGate` and passed, while the real
   `applySnapshot` path deleted the destination BEFORE the gate ran. A pure-function test cannot
   see orchestration. *If the defect is in the ordering of effects, the test must run the thing
   that orders them.*
2. **The harness hid the condition.** A stdout-truncation test used `Bun.spawn`, which drains the
   child concurrently — so the full-64 KiB-pipe condition never occurred and the test passed
   against code that truncated 94% of the payload. The faithful version is a real shell pipeline
   with a sleeping reader. *Reproduce the condition, not an approximation of it.*
3. **The identity function.** A provenance test passed a hand-built object through
   `assembleDoctorReport` (which, without house-rules, returns its input) and asserted it came
   back. Deleting the field's construction left it green. *Test the construction, ideally through
   the real command.*
4. **The non-discriminating fixture.** `findRepoRoot` on a lone empty `.git` returns the same
   answer whether the walk rejects decoys or accepts anything named `.git`. The discriminating
   case is a decoy NESTED inside a real repo. *Ask: what would this test do if the fix were
   reverted? If the answer is "pass", it is not a test.*
5. **Green for an environmental reason.** A test passed only because a gitignored `.env` happened
   to exist in that worktree; a fresh clone would have failed. *Isolate what you depend on —
   cwd, HOME, `PLANE_*` env — or you are testing the machine.*

6. **The input shape no test ever supplied.** (Added 2026-08-17, §9.5e.) Every fake returned
   Plane's `/issues/` string form for relation refs, so the entire suite passed identically before
   and after fixing a defect that silently emptied five consumers on `/work-items/`. Nothing here
   "could not fail" in the earlier sense — the tests were fine; the *inputs* were monocultural.
   **The rule is about WHICH fake, and review sharpened it:** a fake that stands in for the
   *client* must carry the client's post-normalization contract (and `makeFakeClient` now returns
   `normalizeRelations(state)`, so it cannot drift from production); a fake that stands in for
   `fetch`/`request` must carry **every wire variant**, because that is the layer where a
   configuration-dependent shape actually differs. Retrofitting wire shapes into consumer fakes
   would test a state production can no longer produce. The 694-test suite staying green was
   therefore expected — the gap was that nothing faked the WIRE.

**The habit that catches all five: after writing a test, revert the fix and watch it fail.** Every
fix in the 2026-08-17 work carries that red-then-green evidence in its commit message. It is
cheap, and it is the only thing that distinguishes a test from a decoration.

**A related process failure worth the same vigilance:** three scripted edits that night silently
matched nothing, and two commit messages consequently described work that was not in the tree.
Assert your anchor before writing, and re-read the file after — a no-op edit exits zero.

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
