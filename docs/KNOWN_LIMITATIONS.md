# Known limitations

## Non-standard Acceptance-Criteria heading forms are not fully round-trip-stable

**Status:** pre-existing (not introduced by any single feature); low priority.
**Discovered:** 2026-07-28, during the developer-day effort feature's pair review.

`splitBody` (`src/markdown/criteria.ts`) locates the Acceptance-Criteria section by matching an
**ATX** heading on the *raw* markdown: `### Acceptance Criteria` (the documented, template convention).
Plane stores descriptions as HTML and returns them as markdown, and that round-trip **normalizes
heading forms** — e.g. a Setext heading (`Acceptance Criteria` underlined with `===`) becomes ATX
`# Acceptance Criteria`, and an AC heading hidden inside an HTML comment is dropped entirely.

Consequence: for a story whose AC heading is written in a **non-ATX / non-standard form**, the narrative
that `splitBody` computes on the raw file can differ from the one it computes on the board-returned
(canonical) form. That makes such a story's `--sync-criteria` hash — and any field derived from the
narrative boundary (e.g. `effortDays`) — potentially differ file-vs-board. This affects **criteria
extraction itself**, independent of the effort feature.

**Scope in practice:** none for the documented convention. Agent-authored specs (and the
`templates/user-story.md`) use ATX `### Acceptance Criteria`, for which everything is consistent and
round-trip-stable. The effort feature additionally **declines to inject** a YAML-materialized effort line
whenever it would not survive the canonical round-trip (so it never *orphans* a line even on these
exotic inputs — it just records no effort, which `lint` surfaces as "missing effort").

**Proper fix (future):** determine the AC boundary on the canonical form consistently for both
`splitBody`-for-hashing and detection (i.e. canonicalize before splitting everywhere), or make
`AC_HEADING` recognition invariant across the HTML round-trip (ATX + Setext + closed-ATX). Either is a
shared `splitBody`/hash change with a one-time re-hash, out of scope for the effort feature.

**Recommendation:** write the acceptance-criteria heading as `### Acceptance Criteria` (ATX), as the
template and `USER_STORY_FORMAT.md` show.

## `--dry-run` cannot preview a dependency on an item created in the same run

**Status:** fundamental (Plane assigns identifiers server-side on create); low impact.

A dependency references its target by Plane identifier (`DATA-20`). A brand-new story has no identifier
until Plane creates it and assigns the next sequence number. So a story that references an identifier
which will only be *assigned during this same import* cannot be resolved in `--dry-run` (the item does
not exist yet and its future identifier is unknowable without creating it). Dry-run reports such a target
as not-found and, consequently, cannot preview a dependency cycle that would only close through it. Apply
mode resolves it correctly, because it reconciles relations *after* creating the stories, against a fresh
index.

**Recommendation:** author dependencies against items that already exist on the board. The natural flow
already does this — import a story (its `plane_identifier` is written back into the file), then reference
that identifier from another story. Only the fragile pattern of hand-guessing an unassigned identifier is
affected, and only in the preview.

## Dependency cycles: client detection is best-effort; Plane is the backstop

planestories detects dependency cycles client-side and, on `import`, **skips only the cyclic edges**
(reporting them) while still syncing every other relation — one bad cycle never blocks a whole batch.
Client detection sees the imported stories plus their directly-referenced targets, so it catches a
self-reference, a 2-node cycle, and a cycle closed through **one** non-imported board item. A cycle
closed through **two or more** consecutive non-imported items is not visible client-side.

That residual is safe: **Plane itself refuses to persist a cycle-creating relation** (verified — the
create request returns success but the edge is silently not stored). So no cycle can ever form on the
board regardless of client-side detection; the only effect of a missed deep cycle is that the offending
edge is not created (and a later re-import harmlessly re-attempts it). Client detection exists to give an
early, clear error for the common cases.

## A story that references its own to-be-assigned identifier re-hashes once

If a brand-new story declares a dependency on the identifier Plane will assign to it *this run* (e.g. a
new story with `blocks: [ENG-101]` that becomes `ENG-101`), the self-reference cannot be stripped at
parse time (the story has no identifier yet), so the first stored hash includes it. On the next import
the story now has its identifier, the self-reference is stripped, and the hash differs — causing one
extra work-item update, after which it is stable. The reconciler never creates the self-edge either way.
Avoid referencing an identifier that will only be assigned during the same run (the same guidance as the
dry-run limitation above).
