# `replicate` — migrate a Plane project between instances

Moves one Plane project (cloud ↔ self-hosted CE, either direction) with **exact
`PROJECT-N` identifier preservation**, fully programmatically. Two decoupled halves
around an on-disk snapshot file, plus a one-shot wrapper:

```bash
# 1. The ONE expensive paced read → a self-contained, versioned JSON file
planestories replicate snapshot --from cloud -p "Data Platform" -o data.snapshot.json

# 2. The phased writer — ZERO source reads; dry-run by default
planestories replicate apply --to ce --snapshot data.snapshot.json          # dry-run
planestories replicate apply --to ce --snapshot data.snapshot.json --yes    # real

# One-shot: chains both; the snapshot file is persisted and its path printed
planestories replicate --from cloud --to ce -p "Data Platform" --yes
```

`--from`/`--to` name credential **contexts** (`PLANE_CTX_<NAME>_*` env vars or
config-file entries); omitted = the bare `PLANE_*` environment.

## What the snapshot is

Everything replicate carries (see Fidelity below for exactly what that is) —
project settings, states, labels, members (for email mapping), every work item
(including archived) with raw `description_html`, relations of all kinds,
comments, and the **sequence map** (present numbers + gaps) — under a content
sha256 **digest**. It is deterministic and diff-stable, so it doubles as a
**backup of everything it carries** (NOT of attachments, cycles, modules, pages,
activity history, or reactions — those are outside snapshot schema v1). It holds
board content: treat it as data; don't commit it to shared repos by default.
`apply` recomputes the digest and refuses edited/corrupted files — re-snapshot
instead of hand-editing.

Snapshot reads are paced (two-phase sweep) and **fail hard on any partial read**:
a snapshot missing relations or comments is never written.

## How exactness works

Plane assigns `sequence_id = max-ever + 1` per project and **never reuses deleted
numbers** (empirically probed on both Plane Cloud and the operator's CE, 2026-08-09).
Apply therefore: creates the destination project itself (sequence-pristine),
creates items **strictly serially in ascending source order**, consumes each source
gap with a marker **placeholder** item, asserts every returned sequence number, and
deletes the placeholders at the end. Any drift (e.g. a concurrent write to the
target) poisons the run's journal and aborts; recovery is `--recreate-target`
(drop + rebuild the run-created project — cheap, the journal replays).

**Before any destination write**, an empirical probe (run inside a throwaway
`PSPRB*` project, always deleted) verifies the target's sequence semantics,
`created_at`/`created_by` acceptance, relation kinds, the archive verb, and state
writes. If exact identifiers are infeasible the run **aborts up front** — never a
half-written destination — naming the two explicit opt-outs:
`--no-exact-identifiers` (accept renumbering) or `--allow-sql-finalize` (reserved;
not implemented in this build, fails closed).

## Fidelity

- **Native where accepted** (probe-decided): `created_at`/`created_by` on items and
  comments, email-mapped to target members. Otherwise comments get a visible
  provenance footer keyed by the source comment UUID.
- **Verbatim**: `external_source`/`external_id` (keeps existing story files warm),
  `description_html`, priorities, points, dates, labels (color/description/parent),
  states (matched by name+group; colors/descriptions patched onto Plane's defaults).
- **Archived items are replicated as archived** (probe-gated verb).
- **Degradation/loss manifests**: every fallback (unmappable authors, rejected
  relation kinds, missing archive verb) is counted in the apply report. V1-out
  entities are reported as losses: `updated_at`/`completed_at` counted per item;
  cycles/modules/pages and attachments/activity/reactions as categorical notes
  (they are not inventoried in snapshot v1 — description-embedded asset URLs
  still point at the source instance).
- If the source's archived inventory endpoint is unavailable, sequence gaps cannot
  be distinguished from invisible archived items: the gate fails closed until
  `--assume-gaps-deleted` is passed deliberately.

## Crash safety and resume

Every real apply writes an append-only, fsync'd JSONL **journal** next to the
snapshot (`<snapshot>.apply-<workspace>.journal.jsonl`, or `--journal`), bound to
the snapshot digest + target instance and guarded by a pid lockfile. Re-running
the same command resumes: completed work is skipped; an ambiguous create (crash
between POST and journal) is reconciled by expected sequence + fingerprint before
any re-POST — a foreign item at an expected number fails closed. Work-item creates
never use blind client retries (a replayed POST would burn a sequence number
forever).

Placeholder cleanup is **one-way**: once it starts, item creation can never resume
for that journal (deleted numbers are gone); an incomplete journal in that state
requires `--recreate-target`.

`--limit N` pauses after N creates (resumable) — useful for rehearsals.

## Cutover verification

Apply ends with a light sequence/identity check. Before cutover, run the full
read-only, bidirectional comparison:

```bash
planestories replicate verify --to ce --snapshot data.snapshot.json
planestories replicate verify --to ce --snapshot data.snapshot.json --json -o verify.json
planestories replicate verify --to ce --snapshot data.snapshot.json --export-file stories.md
```

Verify resolves the target project and every source→target item mapping from the
completed apply journal. It checks the complete live+archived set, exact sequence
numbers, scalar fields, state/label/parent resolution, probe-accepted authorship
and timestamps, normalized HTML plus a markdown second opinion, comments,
relations, and source-instance asset/cross-links. Any failure exits 1; warnings
(including known probe-rejected relation kinds and markup-only transformations)
exit 0. `-o` always writes the full JSON report, even with human console output.

## Relink story files

After verify is green, preview the offline corpus rewrite, then apply it:

```bash
planestories replicate relink --to ce --snapshot data.snapshot.json stories/ docs/story.md
planestories replicate relink --to ce --snapshot data.snapshot.json --yes stories/ docs/story.md
```

Relink recursively scans directories for `*.md` and updates only parser-located
story YAML values whose `plane_id` is mapped by the journal: UUID, destination
prefix/sequence, and browser URL. Dry-run is the default. All files are parsed
and transformed before any write; real writes use a same-directory temporary
file and rename. Foreign/deleted IDs warn and remain untouched.

## Snapshot freshness

Immediately before cutover, cheaply confirm that the source has not changed:

```bash
planestories replicate freshness --from cloud --snapshot data.snapshot.json
planestories replicate freshness --from cloud --snapshot data.snapshot.json --json
```

Freshness uses the snapshot's recorded endpoint dialect and compares item count,
sequence set, maximum `updated_at`, and per-item `updated_at`. Any added, deleted,
or edited item exits 1. If the source does not serve archived inventory, the live
inventory is compared and the resulting limitation is reported explicitly.

## Rename the destination project

Project renames are single-project and dry-run by default:

```bash
planestories rename-project --context ce --project DST --name "Data Platform"
planestories rename-project --context ce --project DST --identifier DATA --yes
```

The project resolves by case-insensitive identifier or exact name. Changing the
identifier changes every work-item prefix workspace-visibly, so both preview and
apply print a warning.
