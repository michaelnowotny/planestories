# planestories — improvement plan from production feedback (2026-07-17)

Source: 3 weeks of production use in the finance_csv_importer session (815-item board, weekly
epic imports, full-board audits, a 454-open-ticket hygiene audit). This plan responds to that
feedback. It is a design + sequencing plan, not yet implemented.

## Guiding principle (the reframe most of this points at)

Today planestories treats the markdown file as the source of truth for **everything** and only
pushes file → board. The rot the audit found comes from that assumption: real work completes on
the **board** (Plane UI/MCP flips the parent to Done), the file never hears about it, and
criterion sub-items sit open forever.

The mature model is two sources of truth, reconciled cheaply in both directions:

- **File is source of truth for CONTENT** (title, description, criteria, priority, structure).
  Push file → board, but only when content actually changed (P0-1 hash).
- **Board is source of truth for STATE / completion** (work happens in Plane). Pull board → file
  for state (P1-1 groom reverse-sync), and let parent completion cascade to criterion sub-items.

Read P0-1, P1-1, and P1-3 as the two halves of that reconcile loop. That framing also decides
several open questions below.

## Shared infrastructure to build once (nearly everything depends on it)

1. **`fetchProjectIndex(projectId)`** — one paginated `list_work_items` (expand state, labels,
   type) that returns every item with `{ id, sequence_id, identifier, name, external_id,
   external_source, parent, stateName, stateGroup, labels, typeName }`, plus derived maps:
   `byId`, `byIdentifier`, `byNormalizedTitle`, `childrenByParent`. This single fetch replaces
   the per-item GETs the audit had to do, and backs the duplicate guard, groom, export
   completeness, and doctor. Extend the existing `fetchWorkItems` rather than add a parallel path.
2. **Content hash helper** — `payloadHash(intendedPayload)` over the exact normalized fields we
   would send (name, description_html, priority, state-name, estimate, sorted labels, assignee,
   and, when `--sync-criteria`, the ordered criteria text+checked). Stored in the yaml write-back.
3. **Completed/open state resolver** — already exists (`firstStateIdInGroups`); reuse for groom
   and status closure.
4. **Marker-keyed comment helper** — `ensureComment(itemId, marker, body)` that lists existing
   comments and only posts if the marker is absent. Backs evidence comments and groom's
   "auto-closed with parent" note.

## The plan, prioritized

### P0-2 — Rate-limit resilience (client-level; do first, protects everything)
- In `client.request`, on HTTP 429 (and optionally 5xx), honor `Retry-After` if present, else
  exponential backoff with jitter; retry up to N (default ~5). Only after exhausting retries does
  it throw. Applies to every call, so imports/groom/export all inherit it.
- Continue-on-failure already exists per story; keep it. Print a failed-identifier list in the
  summary. "Resumable state" mostly falls out of P0-1 + external_id idempotency + write-back: a
  re-run skips the succeeded items (unchanged hash) and only retries the ones missing a
  plane_id/hash. Optional `import --retry-failed` = process only stories lacking plane_id or hash.
- Effort: S–M. Risk: low. Knob: `PLANE_MAX_RETRIES`, `--max-retries`.

### P0-1 — Skip-unchanged on import (the single biggest win)
- On successful create/update, write `plane_hash: <hash>` into the story yaml (alongside
  plane_id). On import, for a story with a plane_id, recompute the intended-payload hash; if it
  equals the stored hash, record action `unchanged` and make **zero** write calls.
- Chosen approach: **content hash stored in the file**, not a live GET diff — a per-item GET would
  reintroduce exactly the rate cost the incident was about. Trade-off: a hash-only skip won't
  notice out-of-band Plane edits (file unchanged, board changed). That gap is deliberately owned
  by the other half of the loop (groom reverse-sync); document it. Add `--force` to bypass.
- Summary gains `Unchanged: N`. Acceptance (from feedback): re-importing an unchanged file makes
  0 writes and prints `unchanged: N`. Met.
- Effort: M. Risk: medium (hash must be computed identically at write and read time; flags that
  change payload, e.g. `--sync-criteria`/`--source-label`, must be part of or invalidate the hash).

**Update 2026-07-17 (production feedback from the DATA-board close):**
- Slices 1–3 validated live: status-only closed 80/80 with no 429 stalls, replacing ~160
  rate-limited MCP calls (board 454→375).
- **Finding + fix (shipped, `fb51cee`):** a full-board re-import showed *815 would-update / 0
  unchanged* because **exported files carried no `plane_hash`** — skip-unchanged started cold on
  every export→import cycle. Fixed: export now writes `plane_hash` via the shared
  `src/sync/story-hash.ts` (single source of truth so import/export can't drift). An unedited
  export→import is now `unchanged`/zero-writes. This is the P1-3 "export completeness" hash piece,
  pulled forward.
- **Still open — the hashless-but-LINKED case (was finance ask (b)):** files with a `plane_id` but
  no `plane_hash` (pre-slice-2 write-backs, or hand-authored) still blind-write on first touch.
  Resolve this in **slice 4/5 via `fetchProjectIndex`, NOT a per-item GET** (which would reinstate
  the rate cost decision #2 rejected): for a hashless linked story, reconstruct the board item from
  the ONE index list (same conversion the exporter uses), compute `hashStoryPayload` on it, and if
  it equals the file's hash → skip + adopt (write `plane_hash`). One list call amortized across all
  stories, so it honors decision #2's spirit while killing the one-time blind-write. Dry-run stays
  hash-only (no live compare) unless `--check` is passed. Until built, treat full re-imports of
  PRE-fix exports as unsafe (new exports are already warm); `--status-only`/targeted files remain
  the safe path.

### P1-2 — `import --status-only` (unblocks the imminent ~80-ticket close)
- New import mode: for items with a plane_id, PATCH only `state` (resolved from yaml `status`),
  ignore every other field (no description re-render, no clobber). Items without a plane_id are
  skipped with a warning. Combine with a stored `plane_status` (or the hash) to skip items whose
  state already matches, so a re-run is 0 writes.
- Small, self-contained, high leverage. Effort: S. Do it early (right after P0-1's write-back
  plumbing exists, since it can reuse the stored-state field).

### P0-3 — Duplicate guard on create
- Before creating a story that has no plane_id and no external_id match, look it up in
  `fetchProjectIndex().byNormalizedTitle` (lowercased, trimmed, whitespace-collapsed, within the
  project). On a hit:
  - **Default: skip + loud `duplicate-of DATA-N` warning** (no create, no update). Safety-first,
    because exact-title match is strong but not perfect and adopting the wrong item would then
    overwrite an unrelated board item.
  - `--adopt-duplicates`: write the existing item's plane_id into the file and treat as update
    (the "ideal" path, opt-in).
  - `--force-create`: create anyway (escape hatch for genuine same-title-different-story).
- Acceptance: importing a file whose story already exists in Plane (any creator) never yields two
  items by default. Met.
- Effort: M. Risk: medium (title normalization; decision on default — see Open decisions).

### P1-3 — Export completeness (also makes groom cheap)
- Serializer emits, when present: `parent: DATA-N` (identifier via `byId`→identifier map),
  `kind: story|criterion|epic`, and `labels` (labels already export; confirm). `kind`: criterion
  when external_id matches `::ac\d+`; epic when the item's type name is "Epic" (needs type via
  expand — see Open decisions); else story.
- Add `export --open-only` (state group in backlog/unstarted/started) and repeatable `--status`.
- Parser learns to READ `parent`/`kind` (kind is informational; parent feeds P2 cross-file nest).
- Effort: M. Risk: low (kind=epic detection is the only fuzzy bit; can ship story/criterion first).

### P1-1 — `groom` command (the fragment-rot fix; the big one)
- `planestories groom --project X` (dry-run by default), using `fetchProjectIndex`:
  a. **Close orphaned criterion sub-items**: for each criterion child (external_source
     planestories, external_id `::acN`) whose parent's state group is completed/cancelled and the
     child is still open, set child state to a completed-group state and add the marker comment
     "auto-closed with parent".
  b. **Report duplicate-title pairs** (from `byNormalizedTitle` collisions).
  c. **Report open sub-items whose parent no longer exists** (parent id not in `byId`).
  d. **`--write-back <file>`**: reverse-sync — for each parent in the file, read its children's
     states and tick `[x]`/untick `[ ]` the matching checkboxes (index from `::acN`), so file and
     board re-converge.
- **CRITICAL constraint (v1):** the parent-Done cascade closes ONLY `kind=criterion` children
  (external_source planestories + external_id `::acN`). It must NEVER close real child STORIES of a
  Done epic — epics are sometimes closed with open story children, and those must survive. Gate the
  closure on the criterion marker, not merely "parent is Done".
- **v1 scope = (a) close + (b)(c) report.** Reverse-sync (d) is v2 and needs a file-registry
  mapping `DATA-N -> owning .stories.md` (stories are spread across many per-epic files).
- Also add the cheaper complement: `import --close-done-criteria` (or automatic when a story's
  yaml `status` is Done) closes that story's own criterion sub-items in the same pass.
- `--yes` to apply (like delete); dry-run prints the plan and counts.
- Effort: L. Risk: medium (state-group mapping, comment idempotency, careful file write-back).

### P2 — Smaller items (after the above)
- **Cross-file epic attachment**: story-level yaml `parent: DATA-N` → resolve identifier to uuid,
  set as the created item's parent, so a new file nests under an existing epic without repeating
  the epic block. Removes the "epic block duplicated + re-updated needlessly" problem (interacts
  with P0-1). Effort: S–M.
- **Design-doc import guard**: `--strict` (or default-warn) flags/refuses `##` headings that have
  neither a yaml block nor an Acceptance Criteria section — stops accidental ADR imports (the
  308→309 lesson). Effort: S.
- **Idempotent evidence comments**: optional per-story `comment:` yaml; on a status transition,
  post it once via the marker-keyed comment helper. Effort: S–M.
- **`doctor` for CI**: read-only board scan (orphaned fragments, duplicates, parentless children);
  exits non-zero when rot exists. Thin wrapper over the groom analysis with `--fail-on-findings`.
  Effort: S.

## Decisions (LOCKED 2026-07-17, by the finance production session)

1. **P0-3 = skip-with-warning; adopt only behind `--adopt-duplicates`.** Deciding evidence: the
   board genuinely contains exact-title items that are DIFFERENT things (templated AC titles reused
   across sibling slices; four estimator stories duplicated verbatim), so silent adopt would
   cross-wire and clobber the wrong item. Three hard rules:
   a. matching is **EXACT normalized title only** (case + whitespace). Never fuzzy.
   b. `--adopt-duplicates` with **multiple** title matches is a **hard error** listing the
      candidates. Never auto-pick.
   c. the skip warning prints the existing item's **identifier + state**, so a human can hand-adopt
      by pasting the plane_id block (one-step version of the current recovery ritual).
2. **P0-1 = content-hash of the RENDERED payload** (post markdown-to-HTML), so cosmetic reflow
   doesn't trigger writes. The out-of-band-edit gap is correct under the model (file-unchanged +
   Plane-edited → skip → the Plane edit survives). Optional belt: groom may REPORT content
   divergence (live description hash != plane_hash) as an FYI line, report-only, never auto-resolve.
3. **`kind`: ship `story|criterion` now; add `epic` later.** Do not block P1-3. Meanwhile epics are
   inferable as parent-absent + has-children. Adding `kind: epic` later is additive.
4. **groom v1 = close/report only. Reverse-sync (d) = v2.** Reverse-sync needs a file-registry
   (which .stories.md owns DATA-N) because stories are spread across many per-epic files; design it
   properly, don't rush. See the CRITICAL cascade constraint in the P1-1 section.
5. **YAML key names LOCKED:** `plane_hash` (fits the plane_* namespace), `parent` (value = human
   identifier "DATA-N", not uuid), `kind` (story|criterion|epic), `comment` (single string,
   marker-keyed idempotent append). **Do NOT add `plane_status`** — `status:` already IS the state
   key; a second status-like key recreates the divergence bugs this program is killing. If
   "state as of last sync" is ever needed for diffing, fold it into the hash, do not expose a key.

Consumer note: the finance session is the live first consumer. The pending ~80-ticket audited
closure will use `--status-only` (slice 3) as its first production run if slices 1-3 land within a
couple of days; groom's close/report (slice 6) then executes their ~200-fragment sweep. They will
report real-board regression numbers (unchanged-skip rate, 429 counts, groom closures) per slice.

## Suggested sequencing (each a shippable slice)

1. P0-2 backoff (protects everything).
2. P0-1 skip-unchanged + write-back plumbing (foundational).
3. P1-2 `--status-only` (rides on the write-back field; unblocks the 80-ticket close now).
4. Shared `fetchProjectIndex` + P0-3 duplicate guard.
5. P1-3 export completeness (reuses the index).
6. P1-1 groom (reuses the index; the reconcile loop's board→file half).
7. P2 batch (cross-file parent, strict guard, evidence comments, doctor).

## Verification (per slice)

- Unit tests against the fake client for each new path (unchanged-skip makes 0 writes;
  status-only touches only state; duplicate guard never double-creates; groom closes only
  parent-Done children; export emits parent/kind).
- A 429 simulation test for the backoff (stub fetch returns 429 then 200; assert retry + honor
  Retry-After).
- Live shakedown in the Bloomenkohlberg sandbox (create parent + criteria, flip parent Done,
  groom, confirm children close and file re-converges), then hand back to the finance session for
  a real-board pass before merge.

## Don't regress (confirmed working)

Export→import round-trip fidelity; plane_id write-backs; `--dry-run --check`; project routing;
epic-heading nesting within one file; identifier-based updates when the plane_id block exists.
