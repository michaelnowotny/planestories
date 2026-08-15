# Tier 1 design decisions — effort, relations, lint (2026-07-28)

Why the Tier-1 features are built the way they are: the decisions, the alternatives we rejected and
why, the empirically-verified Plane-API facts, and the load-bearing gotchas that are easy to forget.
Read this before changing `src/markdown/directives.ts`, `src/sync/relations.ts`, or `src/lint/`.

Source of the requirements: the data-platform team's brief, forwarded as
`docs/planestories-improvement-brief-2026-07-28.md`. **That file is gitignored** (the
`planestories-*` pattern keeps forwarded cross-repo briefs out of git), so it exists only on the
machine it was delivered to — do not treat it as a dependency. Everything durable from it lives in
this document and in `docs/HANDOFF.md`. The reply was
`~/PycharmProjects/finance_csv_importer/external_info/planestories-tier1-report-2026-07-28.md`,
likewise gitignored in that repo.

## Verified Plane-API facts (throwaway items on the live DATA board, cleaned up)
1. **`point` is integer-only.** `POST issues/ {point:2.5}` → 400 "A valid integer is required." → decimal
   effort cannot use `point`.
2. **Integer `point` persists even with NO estimate system configured** (`point:3` round-trips;
   `estimate_point` stays null).
3. **Relations REST:** read `GET …/issues/{id}/relations/` → object with `blocking/blocked_by/relates_to/
   duplicate/start_*/finish_*` arrays of UUIDs. Create `POST …/issues/{A}/relations/ {relation_type,
   issues:[B]}`. Delete `POST …/issues/{A}/relations/remove/ {relation_type, related_issue:B}` (the
   `remove-relation/` path 404s).
4. **Relations AUTO-MIRROR:** create "A blocked_by B" ⟹ B shows "blocking:[A]". One edge, both ends.
5. **Plane silently DROPS cycle-creating relations:** the create returns success but the edge is not
   stored. So no cycle can EVER form on the board at any depth — Plane is the backstop.
6. **Custom relation *definitions* are paywalled** (402). Built-in relations only.

## Effort (`src/markdown/directives.ts`, parser, hash, board-story)
**Decision:** the `**Effort:** N.n dev-days` body line is the source of truth; `effort_days:` YAML is
sugar materialized into that line; `estimate`/`point` are untouched.
- **Rejected — map decimal effort onto `point`:** impossible (`point` is integer-only, fact #1).
- **Rejected — a Plane custom property:** custom *definitions* are paywalled (fact #6); untested/fragile.
- **Rejected — a separate hash field for effort:** unnecessary. Because effort lives in the description
  body, it is already covered by the content hash via `descriptionHtml`. Adding a field would double-count.
- **THE hard-won gotcha (11 review rounds):** effort detection must agree with (a) what the content hash
  sees and (b) what the board stores/returns. Both are achieved by detecting on the CANONICAL form —
  `htmlToMarkdown(markdownToHtml(splitBody(body).narrative))` — the exact transform the Plane description
  round-trips through. This makes `marked` (a real CommonMark engine) own ALL code/heading parsing:
  indented code, raw HTML, `<pre>`, fenced/nested/odd-length fences are normalized, so a `**Effort:**`
  that is really code is never read. A hand-rolled fence scanner will NEVER match CommonMark — don't try.
- **Injection is orphan/duplicate-proof:** a YAML-materialized line is accepted only if it re-parses to
  the same value in BOTH raw and canonical form (rejects lines a fence/heading-shift would swallow), and
  only if NO effort marker exists anywhere already (raw or canonical). `parseYamlEffort` rejects
  non-finite/negative/boolean/blank/precision-losing/out-of-range (>100000) values.
- **`splitBody` recognizes ATX + closed-ATX + Setext AC headings** (`acHeadingIndex`) so the narrative
  boundary is invariant across Plane's HTML round-trip (Setext `===`/`---` normalizes to ATX). This also
  fixed a pre-existing splitBody bug (Setext criteria extraction).
- **Authoring rule:** the `**Effort:**` line must be its own paragraph (blank-line separated), in the
  narrative BEFORE `### Acceptance Criteria`. Not separated → it's mid-paragraph → not a directive.

## Relations (`src/sync/relations.ts`)
**Decision:** YAML fields + real Plane built-in relations are canonical; body-line sugar is stripped from
the description on import; reconciliation is a GLOBAL post-create phase over a FRESH index.
- **Rejected — keep dependencies in the description prose:** loses the native blocker UI, atlas edges,
  and board-side checkability. The whole point is real relations.
- **Rejected — per-story reconciliation:** Plane auto-mirrors (fact #4) and a relation can be declared
  from either end, so a per-story pass thrashes. A GLOBAL phase over all synced stories + a canonical
  edge key (read both `blocked_by` and `blocking` → same key) dedups the mirror. Each edge is created
  ONCE from one canonical endpoint, guarded idempotent against freshly-read current relations.
- **Removal semantics — the subtle one (2 review rounds):** an edge is removed ONLY when BOTH endpoints
  are in the CURRENT import batch (`syncedIds`) AND both are `external_source=planestories`.
  - Why "both in batch": Plane relations carry NO provenance, so we can't tell a planestories edge from a
    human/UI edge between two managed items. Requiring both endpoints in the batch means a single-file
    import is ADD-ONLY for relations — no thrash (importing B alone can't delete A's declared edge), and
    no deleting asymmetrically-authored or human-added edges. **Consequence:** to REMOVE a dependency you
    must re-import BOTH endpoints (normally the full project story set). Document this for users.
  - **Rejected — remove whenever both endpoints are managed:** deletes human UI links and thrashes on
    subset imports (Codex/Grok caught this).
- **Cycle handling — SELECTIVE apply (the Grok/Codex disagreement, resolved):** skip ONLY the cyclic
  edges (a block edge whose `blocked` can already reach its `blocker` in the desired+preserved graph),
  report the cycle, and sync EVERYTHING else. Withhold `plane_hash` only for stories whose edge was
  skipped.
  - **Rejected — all-or-nothing abort:** one stray cycle in a full-board import blocked EVERY relation.
    (I built this first; both engines flagged the write-scope/hash-scope inconsistency; selective apply
    is strictly better for the team's big-batch workflow.)
  - Client cycle detection fetches imported issues + their direct edge targets (catches a one-hop
    cross-file cycle). Deeper (>1 non-imported hop) cycles elude client detection but are BACKSTOPPED by
    Plane (fact #5), so no board cycle can form — documented in KNOWN_LIMITATIONS.
- **Hash is backward-compatible:** the three relation sets join `payloadHash` ONLY when present, so
  relation-free stories keep their legacy hash (no mass re-import churn). Sorted/normalized so reordering
  doesn't flip the hash.
- **Concurrency bounded to 6** (`mapWithConcurrency`) in reconcile AND export — 800+-item boards else
  open 800 concurrent relation GETs.
- **fetch fan-out is FRESH** (not the per-story cache) so items created earlier in the same import are
  resolvable and their `external_source` is known.

## Lint (`src/lint/`)
**Decision:** offline, mechanical, file-based, non-zero exit for CI; complements (doesn't duplicate)
`doctor` (board-side) and `/rate-userstories` (LLM).
- **Identifier resolution mirrors the real consumers (the subtle fix):** PARENT-related rules
  (orphan-criterion, bad-parent, parent-dangling, and the shared epic classifier) resolve EXACTLY —
  because import resolved `parent` exactly (`index.byIdentifier.get(story.parent)`, case-sensitive) and
  atlas links children by raw keys.
  > ⚠ **DRIFT (discovered 2026-08-15, unresolved).** Commit `c31fe51` wrapped the importer's parent
  > lookup in `normalizeIdentifier`, so **import now uppercases the file's `parent:` value** and
  > accepts `eng-7` where it previously required `ENG-7`. That was an unintended side effect of a
  > dry-run-diff fix (the intent was only to stop a phantom case diff in the PREVIEW), and it
  > inverts the invariant stated above: lint is now STRICTER than import, so lint can report a
  > dangling parent that import happily resolves. Nothing false-passes, but the two no longer
  > mirror each other. The decision of which behaviour to keep is open — see `docs/HANDOFF.md`
  > §9.7. DEPENDENCY rules (cycle, dep-dangling) resolve NORMALIZED (uppercase)
  — because the parser uppercases the dep sets and relations resolve case-insensitively. Using one
  normalization for everything false-passes a case-mismatched parent that import would reject.
- **`classifyFileEpics` is RAW/exact** — the shared epic detector must be behavior-preserving for atlas
  (atlas tree assembly uses raw keys). Do NOT normalize it.
- **Tarjan SCC is ITERATIVE** (explicit stack) — the recursive version overflowed on a long acyclic
  chain (a valid input crashing).
- Dangling references are WARNINGS (they may legitimately exist on the board), never hard errors even
  under strict. `--warn-only` downgrades all findings and exits 0 for gradual adoption; strict is default.

## Process notes for future work here
- Builds were DELEGATED to Codex (`setsid nohup ~/.local/bin/codex exec -C <worktree>
  --sandbox danger-full-access -c model_reasoning_effort=high "<brief>"`) to conserve orchestrator
  tokens, then reviewed. This worked well: Codex produced solid first drafts; the pair review caught the
  real reconciliation/atlas bugs.
- Every change got Grok + Codex pre-merge pair review via `scripts/external_review.sh <engine> <workdir>
  <brief> <report>` (GROK_BIN=`$HOME/.grok/bin/grok`). **Launch review tasks ONE AT A TIME** — running
  two concurrent background review tasks reliably got them killed by the harness; solo tracked tasks
  survived. Codex occasionally HANGS (log stops advancing) — detect via a stale log mtime, kill, and
  either re-run or adjudicate on the independent engine + your own verification.
- Effort took 11 review rounds (markdown code-parsing is a deep surface); relations 4; lint 1+hang.
  Each round found a genuine correctness bug — the discipline is worth it for correctness-sensitive
  reconciliation/round-trip code.
