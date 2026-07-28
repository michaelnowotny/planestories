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
