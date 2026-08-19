# `replicate` — migrate a Plane project between instances

Moves one Plane project (cloud ↔ self-hosted CE, either direction) with **exact
`PROJECT-N` identifier preservation**, fully programmatically. Two decoupled halves
around an on-disk snapshot file, plus a one-shot wrapper:

```bash
# 1. The ONE expensive paced read → a self-contained, versioned JSON file
planestories replicate snapshot --from cloud -p "Data Platform" -o data.snapshot.json

# ...and, when you are about to RETIRE the source, also archive its audit trail
# (+1 request per item, so opt-in — see Fidelity)
planestories replicate snapshot --from cloud -p "Data Platform" -o data.snapshot.json \
    --with-activity

# 2. The phased writer — ZERO source reads; dry-run by default
planestories replicate apply --to ce --snapshot data.snapshot.json          # dry-run
planestories replicate apply --to ce --snapshot data.snapshot.json --yes    # real

# One-shot: chains both; the snapshot file is persisted and its path printed
planestories replicate --from cloud --to ce -p "Data Platform" --yes
```

`--from`/`--to` name credential **contexts** (`PLANE_CTX_<NAME>_*` env vars or
config-file entries). **Omitting them is only valid when the config defines no contexts**, in which
case the bare `PLANE_*` environment is used. If contexts exist, `replicate` refuses rather than
choosing one — including when a `defaultContext` is set, and including when there is only one.
Every other command will infer in those cases; this one will not, because it writes an entire
project into whichever instance it picked.

## What the snapshot is

Everything replicate carries (see Fidelity below for exactly what that is) —
project settings, states, labels, members (for email mapping), every work item
with raw `description_html` — including archived items **when the instance serves
the archived-items endpoint** (it records `archivedInventory: "unavailable"` when
it does not, which is the case on both of our instances today) — relations of all kinds,
comments, and the **sequence map** (present numbers + gaps) — under a content
sha256 **digest**. It is deterministic and diff-stable, so it doubles as a
**backup of everything it carries** (NOT of attachments, cycles, modules, pages, or
reactions — those are outside snapshot schema v1; the **activity/audit log is carried
only when you pass `--with-activity`**, and is archival-only — see Fidelity). It holds
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

Three categories, deliberately distinguished — they invite very different follow-up:

**1. Preserved.** `external_source`/`external_id` (keeps existing story files warm),
`description_html`, titles, priorities, points, start/target dates, labels
(color/description/parent), states (matched by name+group; colors/descriptions patched
onto Plane's defaults), parent hierarchy, relations, **comments in full** — and,
probe-permitting, native `created_at`/`created_by` on items **and** comments,
email-mapped to target members. Unmappable authors fall back to a visible provenance
footer keyed by the source comment UUID.

**2. Impossible — the server owns these fields; no client can set them.** Measured on a
live instance 2026-08-17, not inferred:

| Field | On create | On PATCH | Why |
|---|---|---|---|
| `created_at` | **accepted** | — | Plane's create view deliberately copies it after save (an import affordance). The POST *response* echoes server time; only a re-read shows the historical value that persisted. |
| `completed_at` | ignored (`null`) | `200 OK`, **unchanged** | Server-derived from the state transition. Supplying it *while* moving into a completed state still yields `now()`. |
| `updated_at` | ignored | `200 OK`, **server-stamped** | `auto_now`: overwritten on every save by definition. |

Consequence: a post-apply backfill of `completed_at` is **not possible** — PATCH returns
`200` and silently changes nothing, which is the worst failure mode there is. What this
does and does not cost you: the completed/cancelled **state** transfers, so *"what is
done"* is intact; only *"when it was completed"* is absent from the board. Both values
remain in every snapshot, so they are recoverable as data, just not as board state.

**3. Out of scope in v1 — implementable, simply not built.** Cycles, modules, pages,
intake and reactions. Formal attachments are not inventoried; description-embedded asset
URLs still point at the source instance, so check your own exposure before retiring a
source (a one-line scan of `descriptionHtml` for `<img`/external hosts answers it).
Multi-assignee collapses to the first by email.

**The activity/audit log is CAPTURABLE but never replayed.** `snapshot --with-activity`
records each item's trail (verb, field, old/new value, actor, timestamp) so a source
instance can be retired without destroying its history. It is deliberately archival only:
Plane stamps its own activity as the replica is written, and forging an audit trail on the
target would be worse than not having one. Cost is one extra request per item, which is
why it is opt-in and why the nightly backup does not inherit it. (Comments are a separate
matter and are **preserved in full**, with original authorship and timestamps.)

Absence is never ambiguous: `source.activityInventory` is `"captured"` or
`"not-requested"`, the `activities` section is present exactly when the former holds
(`parseSnapshot` rejects a file where the two disagree), and because the sweep is
fail-hard an item missing from a captured section provably has no history. A snapshot
written before this existed carries neither field, parses unchanged, and keeps its
original digest.

### ⚠ Identifiers are preserved. Internal UUIDs are NOT.

`DATA-2114` really is `DATA-2114` on the target — that is the whole point of the engine,
and it makes it natural to assume the snapshot's *other* ids travel too. **They do not.**
The apply MINTS new objects on the destination, so the project, every state and every
label has a new UUID there:

```
cloud  Cancelled = eeadf60d-7929-44dc-ae7f-1150d2d01a0e
CE     Cancelled = 3adcc2a1-7876-4a91-bd2d-2301fe8ede98
```

Using a snapshot's state id against the target gives
`HTTP 400: state: Invalid pk … object does not exist` — loud, thankfully, but only after
you have written the script. **Resolve state, label and project ids from the TARGET, never
from the snapshot.** Human identifiers are the only stable cross-instance handle, which is
why `retrieve_by_identifier` is the MCP call worth knowing.

(Related trap one layer out: the wire field is named `state` — in both the REST API and
the MCP — even though this snapshot schema calls it `stateId`. See
`docs/USING_WITH_CLAUDE.md`.)

Every fallback and every v1-out entity is counted in the apply report rather than hidden.

**Archived items** are replicated as archived where the instance supports it. Note that
Plane serves the archived list **only under the `work-items` spelling** — and not at all
on some self-hosted versions. When a source's archived inventory is genuinely
unavailable, sequence gaps cannot be distinguished from invisible archived items, and the
gate fails closed until `--assume-gaps-deleted` is passed deliberately.

## The divergence guard

`apply` refuses to write to a destination that holds items the snapshot has never
seen. This is the protection that matters most after a cutover: once the destination
becomes the authoritative board it starts accumulating work the source knows nothing
about — folded criteria, new tickets, edits — and applying a stale snapshot over it
destroys that work **silently, totally and irreversibly**.

```
Destination project DATA holds 7 item(s) this snapshot has never seen
(DATA-2568, DATA-2569, DATA-2570, DATA-2571, DATA-2572, and 2 more). The destination
has diverged from this snapshot — applying it would overwrite that work irreversibly.
Re-snapshot the destination if it is now authoritative, or pass
--allow-divergent-target if you truly mean to overwrite it.
```

Three properties worth knowing:

- **It compares CONTENT, not ownership.** The journal-ownership check is a different
  protection, and it is satisfied the moment somebody frees the destination identifier —
  which is exactly the ritual a normal cutover teaches. Being *able* to perform that
  ritual must not be the same thing as being *allowed* to destroy a week of work.
- **It fails closed on ignorance.** If the destination's inventory cannot be enumerated,
  the run refuses rather than assuming the destination is empty.
- **`--recreate-target` does not bypass it.** That flag destroys precisely the items the
  guard exists to protect, so it is checked too.

Only `--allow-divergent-target` proceeds, and it downgrades the refusal to a warning
that says the divergent work will be overwritten.

**`--recreate-target` on a diverged destination now requires `--allow-divergent-target`
as well.** That flag is the documented recovery for a poisoned journal, and it is the
only apply path that actually destroys destination-only work — so it is exactly the path
a diverged board would be wiped from. The guard runs on LIVE state *before* the delete;
checking afterwards would be checking a world already destroyed. Content alone cannot
distinguish "a stray item planted mid-run" from "a week of work someone did on the
destination", so the tool refuses to make that judgement on your behalf and asks you to
state it.

Items this run itself created (including gap placeholders) are not divergence — an
interrupted run of the same snapshot resumes without complaint.

One honest limitation: on instances that do not serve an archived-items list, only LIVE
items can be compared, and the gate says so in a warning rather than implying a complete
inventory.

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
completed apply journal. It checks the complete item set — live plus archived where
the archived endpoint is available, otherwise live-only, which it states in the report
as an explicit warning rather than silently narrowing — exact sequence
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

`--quick` is a ONE-REQUEST check: it compares the source's item count and highest
sequence id against the snapshot, using the `total_count` Plane already returns in its
paginated envelope.

```bash
planestories replicate freshness --from ce --snapshot data.snapshot.json --quick
```

It exists because the full check costs a complete enumeration, and during a real cutover
the operator could not obtain **any** verdict — the source rate-limited them out — and had
to reason from circumstance instead. A weak answer you can afford beats a strong one you
cannot.

It is deliberately weaker and says so in its own output: it **cannot see an edit to an
existing item**, nor a deletion masked by an addition. Use it to catch obvious drift
cheaply; use the full check (and `--deep`) to certify a cutover.


Immediately before cutover, cheaply confirm that the source has not changed:

```bash
planestories replicate freshness --from cloud --snapshot data.snapshot.json
planestories replicate freshness --from cloud --snapshot data.snapshot.json --deep
planestories replicate freshness --from cloud --snapshot data.snapshot.json --json
```

Freshness uses the snapshot's recorded endpoint dialect and compares item count,
sequence set, maximum `updated_at`, and per-item `updated_at`. Any added, deleted,
or edited item exits 1. If the source does not serve archived inventory, the live
inventory is compared and the resulting limitation is reported explicitly.

Comment- or relation-only edits need not bump an item's `updated_at` (Plane creates
those records without saving the parent issue), so the item-level check states that
blindness in its output. `--deep` closes it: a paced per-item pass compares each item's
comments (by id and content) and relation sets against the snapshot — the full
pre-cutover check.

## Scheduled backups

`replicate backup` writes a dated snapshot, performs a cheap item-level freshness
self-check to flag changes made during the read, and retains only the requested number
of backups for that project. For example, run it nightly from cron:

```cron
17 4 * * * cd $HOME/PycharmProjects/planestories && $HOME/.bun/bin/bun run src/cli/index.ts replicate backup --from cloud -p "Data Platform" --dir $HOME/plane-replication/backups --retain 14 >> $HOME/plane-replication/backups/backup.log 2>&1
```

The working directory must be the repository root because Bun auto-loads `.env` from
the current working directory. The log is append-only, so truncate or rotate it
occasionally.

A backup is a snapshot. Restore one with `replicate apply --to <ctx> --snapshot <file>`.
It contains the same snapshot scope described above: project settings, states, labels,
members, work items, relations, comments, and the sequence map, but not attachments,
cycles, modules, pages, activity, or reactions. Backup files contain full board content;
keep the backup directory out of shared repositories.

## Rename the destination project

Project renames are single-project and dry-run by default:

```bash
planestories rename-project --context ce --project DST --name "Data Platform"
planestories rename-project --context ce --project DST --identifier DATA --yes
```

The project resolves by case-insensitive identifier or exact name. Changing the
identifier changes every work-item prefix workspace-visibly, so both preview and
apply print a warning.

## When a run seems to hang after printing its summary

The work is finished. Every write is awaited before a command returns, so once you see a
completion summary the board is in its final state and interrupting is safe.

What lingers is the runtime, not the work — a connection handle, or simply a consumer
that has not read the command's output yet. The CLI deliberately does **not** force an
exit, because `process.exit()` discards buffered stdout (measured on Bun: a 1 MiB
payload through a pipe arrives as exactly 65,536 bytes) and the condition cannot be
detected from inside the process: `writableLength` always reads 0, and unread stdout is
itself what keeps the loop alive. Truncating a `packet` or a JSON artifact to save a few
seconds is not a trade worth making, so after five seconds the CLI simply says so on
stderr and lets you decide.

## Residual limitations (accepted, and why)

These four are known, confirmed in the code, and deliberately accepted — each is bounded by
something else in the design. They were surfaced by adversarial review of the engine; do not
rediscover them as bugs, and do not remove the comments that record them.

1. **A request already in flight can land after journal-lock loss.** Ownership is asserted before
   every journal append, before every Plane write, and again inside the client's retry loop — but
   a single HTTP request that has already left cannot be recalled. Everything after it is refused
   at three layers. Bounded by: only one process is ever meant to own a run, and the next append
   fails closed.
2. **Live-only verify cannot see a foreign item archived after apply.** Neither of our instances
   serves the archived-items endpoint, so verify runs in live-only mode (it says so in the
   report). An item archived by someone else *after* the apply is invisible to that pass.
3. **The `created_by` capability probe can false-positive on a single-member workspace**
   (`src/replicate/probe.ts`): the only probe-able member may BE the API key's owner, whom the
   server would stamp anyway, so acceptance can read true even where the field is ignored.
   Harmless where it matters (a single-member workspace has one possible author).
4. **A foreign item could in theory be adopted** if it sits at exactly the expected sequence, has
   exactly the expected title, and carries NO external identity (`src/replicate/create.ts`). No
   API-visible field discriminates it. Bounded by the hard requirement that the target project is
   run-created and sequence-pristine — nothing foreign should exist there at all.
