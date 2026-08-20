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
