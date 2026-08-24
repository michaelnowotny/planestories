# Changelog

All notable changes to planestories.

The format is loosely [Keep a Changelog](https://keepachangelog.com/); versions follow
[semver](https://semver.org/). Dates are the date the work landed on `main`.

> **A note on the version history.** `0.3.1` is the last version published to npm. Everything
> below shipped between then and `0.5.0`; there was never a released `0.4.x`, so it is recorded
> as one release rather than split into a retroactive line that never existed.
>
> **The `v1.x` tags in this repository come from upstream
> [linearstories](https://github.com/ijonas/linearstories), not from planestories releases.**
> `v1.0.0` and `v1.1.0` *are* ancestors of `main` (inherited with the fork point); `v1.2.0`–`v1.4.0`
> are not on `main` at all. Either way `v1.4.0` semver-sorts above `v0.5.0`, so a GitHub release cut
> from a `v0.5.0` tag will not be marked "Latest". Decide whether to drop the inherited tags or
> renumber before tagging.

---

## [0.6.0] — 2026-08-23

**Neither 0.5.0 nor 0.6.0 has been published to npm** (publishing is interactive — WebAuthn). If you
publish now, publish 0.6.0; 0.5.0's section below still describes what it contained.

The release that answers board questions without PQL. Community Edition has no server-side
work-item filtering at all — see `docs/PLANE_CAPABILITIES.md` — so planestories fetches the board
once and answers locally, at depths a row filter could not reach.

### Added

- **`capabilities`** — edition, version, dialect, and a measured yes/no for relation
  create/list/**remove**, PQL and the count endpoint. States the NEGATIVES explicitly, because the
  failure mode this exists to prevent is a confident wrong claim about *why* something did not work.
- **Auto-detected dialect** — Plane serves work items under `/work-items/` (CE) or `/issues/`
  (Cloud); an unset dialect used to 404 every relation call and read as a missing API. Detected once
  per context now; an explicit setting always wins, and a failed probe degrades loudly.
- **`show <identifier>`** — one item, human-shaped, with parent and relation TITLES. Exits non-zero
  on a missing identifier, so it works as an existence guard in a script.
- **Board cache** — `board fetch` writes `.planestories/board.json` atomically. Reads print its age
  and REFUSE past a staleness threshold rather than serving stale data silently. The cache is bound
  to instance + workspace + project, so it can never answer about a different board.
  `show` went from **2m34s / 885 requests to 0.103s**.
- **`ls` / `count`** — fixed predicates, AND-composed, no query grammar. A count always prints its
  denominator (`57 open of 69`), because a bare number gets quoted without one.
- **`--json` on every read command.** The five graph verbs emit the same answer as a single
  parseable document carrying its own provenance; an incomplete relation sweep writes **nothing** to
  stdout and exits non-zero, so `| jq` sees an empty document rather than a partial answer that
  happens to parse.
- **`ready`** — open items whose blockers are all done, ranked by what each unblocks.
- **`inconsistent`** — Done items with a non-Done blocker, plus the flip side. The verb that finds a
  *wrong* board rather than a slow one; it found a real one on its first live run.
- **`blocked` / `orphans` / `abandoned`** — stuck work with its blocker chain; items that block
  nothing and are blocked by nothing (neglect as a graph property, not an age one); open items under
  an abandoned parent.
- **`audit`** — writes by the current actor, newest first, stamped with the instance they landed on.
- **`createdAt` / `updatedAt`** on the graph and in `atlas --json`, nullable and never fabricated.

### Fixed

- A relation 404 now names the endpoint dialect in use and the one to try, instead of reading like a
  dead API. Two sessions independently concluded the relation API did not exist.
- One un-removable relation edge no longer poisons an entire import. Plane CE exposes relation
  create and list but **not remove**, and a single failure used to abort the whole reconciliation —
  skipping every create and withholding every story's hash, so the run repeated forever.
- `Exported 0 stories` no longer prints in green with exit 0. An empty export now says whether the
  project index was empty (usually the wrong board) or the filters excluded everything, and names
  requested identifiers that do not exist — exiting non-zero, so it guards a script.
- **`ls` / `count` `--no-estimate` filtered nothing.** Commander maps a `--no-x` boolean onto
  `options.x`, so the predicate read a key that was never set and the documented flag was a no-op:
  `count --no-estimate --open` printed the *unfiltered* open count. Measured on a live board, 389
  before and 277 after. It had passed both a unit test of the underlying function and a CLI test
  that only asserted `--help` mentions the flag — neither invoked it.
- **The "no board selected" refusal named routes that do not exist.** One shared sentence offered
  `<file>` and `--project` regardless of the command; `audit` accepted neither, so following its
  advice produced `unknown option '--project'`. `audit` now has `-p, --project`, and the sentence is
  derived from each command's actual registration.
- **An activity whose `actor` is not a string** was read as "not mine" rather than as an
  unrecognised response — which would have published a confident empty `audit`. It refuses now.
- **`capabilities` inferred the relation surface instead of measuring it** — a successful list GET
  was read as "create works", and the endpoint dialect alone decided whether removal exists. It is
  measured now, read-only, via OPTIONS: Plane returns `Allow: GET, POST` even while rejecting the
  method, and the removal routes 404. An endpoint that states no `Allow` is indeterminate, never a
  negative.
- **`atlas` artifacts carried no provenance.** The HTML and JSON now record which board they came
  from and when that state was observed — an absolute instant, because a relative age frozen into a
  file still reads as fresh weeks later. Two renders of the same input remain byte-identical.
- **A parent cycle silently deleted work.** Every member of a cycle has a resolvable parent, so none
  became a root and the whole group vanished from the tree: a two-story file whose stories named
  each other produced `0 of 0 stories`. It now refuses and names the items involved.


### Changed — `/rate-userstories` scores DISCRIMINATION, not volume

**This changes verdicts.** A story that passed before may fail now, with no change on your side.
Read this before your next rating run.

The old rubric — Specificity 30 / Testability 35 / Completeness 25 / Description 10 — was
**monotonic in writing effort**: adding a criterion, a concrete value, or a paragraph could only
ever raise the score. A rubric with that property cannot distinguish *writing the right things*
from *writing more things*, so length was free and dilution was invisible. The case that surfaced
it: a spec with twenty acceptance criteria produced two defects, and neither was in any of the
twenty — while scoring close to exemplary.

- **New weights** — Discrimination 30 / Risk Coverage 20 / Testability 20 / Specificity 20 /
  Description 10.
- **Every criterion is classified `gate` or `task`** by one question: *describe a build that
  satisfies every OTHER criterion but fails this one — is that build wrong, or merely unfinished?*
  Discrimination is `gates/total` and is **non-monotonic: adding a task lowers your score.**
- **Stories now need an outcome delta** — one sentence saying what is true after this lands that is
  not true now. Missing or circular caps the story at **75%**, below the pass threshold, mirroring
  the epic's missing-rationale cap. `templates/user-story.md` and
  `docs/USER_STORY_FORMAT.md` model it. planestories does not parse the line; the rater and your
  reviewers enforce it.
- **`Completeness` is renamed `Risk Coverage`**, because the name was driving the behaviour: the
  old one asks *have I listed everything*, the new one asks *what could go wrong*.
- **Three anti-patterns added**, all written in precise confident prose: closed enumeration as
  coverage, measurement smuggling, restated title.

**What to do about existing stories.** Nothing urgent — this is a rating change, not a format
change, and every existing file still imports and exports unchanged. When a story next fails, the
fix is usually to delete tasks rather than add anything. **Never delete a gate to raise a score**;
if most of your criteria are gates and there are many, the story is too big and wants splitting.

Rationale and the calibration corpus: `docs/RATE_USERSTORIES.md`,
`docs/RATE_USERSTORIES_CALIBRATION.md`.

### Reliability

- **Every CLI option is now covered by a test that would fail if the option did nothing.** All 251
  options across every command were audited after `--no-estimate` shipped as a no-op; six structural
  invariants now run in CI against the real registered program (the stored attribute must be read;
  no `--no-x` may carry a default; commander's `--no-x` mapping is what every consumer assumes;
  every option and command exercised). Each invariant was sabotaged and watched fail.
- `shellQuote` — which builds the commands refusals tell you to run — had three byte-identical
  private copies and no test. Now one helper, verified by round-tripping values through a real
  shell.

### Known limits

- **Relation REMOVAL is impossible on CE.** `blocked_by` edits are one-way; remove the link in the
  Plane UI. Reported per-edge by `import`.
- **`audit` narrows by `updatedAt`**, and comment- or relation-only writes need not bump it, so the
  window can miss them. Stated in the output.

---

## [0.5.0] — 2026-08-19

The release that made the tool survive a real cutover: the `DATA` board moved from Plane Cloud to
self-hosted CE on 2026-08-16, preserving every identifier, and most of what follows either enabled
that or was found by doing it.

### Added

**Replication engine (`replicate`)** — whole-project migration between Plane deployments with
exact `PROJECT-N` identifier preservation.
- `snapshot` — one expensive paced read into a versioned, digest-bound, deterministically ordered
  JSON. Fail-hard: any read failure aborts and writes nothing.
- `apply` — a phased writer driven ENTIRELY from the file (zero source reads); serial ascending
  creates with gap placeholders and a per-create sequence assertion, so identifiers land exactly.
  Adoption requires a provably empty target.
- `verify` — the cutover gate. Judges by the run's recorded mappings rather than live guesswork;
  bidirectional set equality and normalized-DOM description comparison.
- `journal` — append-only JSONL, fsync per record, trailing newline as the commit marker, pid
  lockfile, ownership asserted before every append and every Plane write.
- `freshness` — snapshot-vs-live drift, with `--deep` for comments and relation sets (which need
  not bump an item's `updated_at`).
- `backup` — dated snapshot, tear self-check, retention prune, atomic no-replace publish.
- `relink` — rewrites `plane_id`/`plane_identifier`/`plane_url` across a markdown corpus from the
  journal mapping, so a cutover does not leave every story file pointing at dead UUIDs.
- `probe` — capability and endpoint-dialect detection (`/issues/` vs `/work-items/`).
- `--with-activity` on `snapshot` — captures the work-item activity trail.

**The Project Atlas** — a self-contained, offline HTML star map of a board (`atlas`).
- The "cockpit" redesign: header gauges, status/label/assignee filter chips, minimap, SCAN with a
  keyboard-navigable contact list, and a per-epic dossier (completion ring, status breakdown,
  total/remaining effort, boundary supply lines, heaviest open stories).
- Layout is **solved at build time**, so the page opens already arranged.
- `--json` emits the same graph the page embeds, as a documented machine-readable format.

**Analysis commands**
- `critical-path` — longest dependency chain and its dev-day floor, per-item slack, and the
  measured biggest lever (the actual drop in the floor when an item completes, which is not the
  item's own size whenever a near-critical path exists).
- `trend` — board health across a directory of snapshots, offline.
- `diff` — structural difference between two snapshots, keyed on the human identifier so a
  cloud-vs-CE comparison is not "everything deleted and re-created".
- `epic` — read-only epic rollup: leaf status breakdown, completion %, Σ effort, blocked/blocking.
- `packet` — a self-contained implementable brief for a coding agent (machine-readable header,
  description, AC with board state, dependencies with their current status, effort, parent epic).

**Authoring and hygiene**
- `lint` — 10 offline mechanical rules over a fileset, plus `.planestories.yml`
  (`lint.strictness`, `lint.disable`) as a committed, non-secret conventions file.
- `doctor` — read-only board health, including dangling-relation detection; `--house-rules` adds
  opt-in lints (missing `**Effort:**`, prose dependencies with no matching relation).
- `groom` — closes orphaned criterion sub-items; `--write-back` reverse-syncs checkbox state into
  the file in place, preserving authored text.
- `migrate-criteria` — folds legacy `::ac<n>` child items into the parent's description task list.
- `set --evidence` — append-only, idempotent evidence comments.
- `import --dry-run` — field-level diff that mirrors the apply path exactly; unresolvable values
  become notes, never phantom field changes.
- Dependency relations round-trip (`blocked_by:`/`blocks:` and the `**Depends on:**`/`**Blocks:**`
  body directives) through a global reconciliation phase with canonical edge keys and selective
  cycle handling.

**Configuration**
- Multiple Plane installations via named contexts, per-context env overrides
  (`PLANE_CTX_<NAME>_*`), and env-only contexts.
- `defaultContext`, plus a single-context config no longer requiring `--context`. An implicitly
  selected context keeps full credential isolation — the bare `PLANE_*` env vars do not apply to
  it, so an ambient cloud key cannot silently authenticate a command aimed at CE.
- The board-reading and import commands announce their resolved target (host · workspace ·
  project · context) before doing any work. `projects` and the `replicate` subcommands do not yet.
- Per-client token-bucket pacing derived from the configured API rate.

### Changed

- Acceptance criteria are **task-list items in the parent's description**, not child work items.
  The old `::ac<n>` children remain supported and `migrate-criteria` folds them.
- Board exports (`atlas`, `export`, `packet`) default into `exports/`, which is gitignored.
- `renderAtlasHtml` requires an explicit dependency-coverage argument; the atlas distinguishes a
  partial relation sweep and a skipped one from "this board has no dependencies".

### Fixed

- **Relation references are normalized in exactly one place.** Plane returns them as bare id
  strings on `/issues/` and as `{project_id, issue_id}` objects on `/work-items/` while the type
  says `string[]`, so on CE five consumers silently saw zero relations — the failure mode was
  silence, not an error.
- A partial relation sweep no longer publishes a dependency floor as if it were complete.
- `critical-path --json` omits `totalDays` when there is no chain, so `jq .totalDays` cannot read
  a floor that was never computed.
- The atlas `NO EST.` cell counts the stories the floor counted, not the subset the identifier
  filter can select.
- The transient-failure retry path no longer converts a 404 into a hard failure, and post-
  exhaustion exceptions are no longer wrapped past the handlers that catch them.

### Documentation

- `docs/CHEATSHEET.md` — every command on one page, for people and for agents; linked from the
  README, `AGENTS.md` and `USING_WITH_CLAUDE.md`.
- README documents `critical-path`, `trend`, `diff` and `defaultContext`, which shipped without it.
- `docs/ATLAS.md` corrected: it documented an `R` key that no longer exists and listed four header
  gauges where six render.

### Security / privacy

- README screenshots are re-shot from a synthetic board; they previously showed real project
  content (`tools/gen_demo_board.ts`).
- Credentials live only in a gitignored `.env` or per-context env vars; committed config carries
  non-secret defaults.

---

## [0.3.1] and earlier

Published to npm; see the git history. planestories is a fork of
[linearstories](https://github.com/ijonas/linearstories) (Ijonas Kisselbach / Stacking Turtles
Ltd., MIT), retargeted from Linear to Plane's REST API.
