# Design: acceptance criteria as description task-lists, not sub-items

**Status:** proposed v2 (2026-08-01, revised after Grok+Codex reasoning review — verdicts REVISE, all
findings folded in). **Author:** planestories dev session.
**Source brief:** `finance_csv_importer/external_info/planestories-criteria-redesign-brief.md`
(operator-approved; measurements verified live on the DATA board that day).

## 1. Problem

`--sync-criteria` creates **one Plane work item per acceptance criterion** (`::ac<n>` children).
On the live DATA board that is **1,698 / 2,399 (71%)** of all work items; the real open backlog is
~308 items, the rest are checklist fragments. `groom` exists only to close orphaned criterion items
after their parent is Done (a 395-item sweep took ~30 min) — recurring maintenance for a self-inflicted
problem. Criteria are the *content* of a work item, not separable *work*.

## 2. Target + the unifying principle

Acceptance criteria live as a native **TipTap task-list** inside the parent work item's
`description_html` (Plane's intended, free-tier home for interactive checkboxes). **No sub-items by
default.**

> **Representation precedence (the load-bearing rule that resolves every dual-truth case):**
> **the parent's description task-list is AUTHORITATIVE for criteria; `::ac<n>` sub-items are LEGACY.**
> Every reader (export, packet, atlas, board-story rebuild, write-back) uses the description checklist
> when present, and falls back to children **only** when the description has no checklist. This makes a
> board that transiently holds *both* representations coherent (description wins), and is what keeps
> migration, export, atlas, and reverse-sync consistent.
>
> **The fence is "does `description_html` contain a task-list (`data-type="taskList"`)?" — NOT "does the
> parent have zero criterion children?"** Migrate *closes* `::ac` children (moves them to `completed`)
> but never deletes them, so migrated parents still HAVE children; keying off child count would make
> every reader ignore the authoritative description. One predicate, `hasDescriptionChecklist(item)`,
> is used by export/packet/atlas/board-story/write-back/migrate alike.

Board→file reverse sync ("tick in Plane UI ⇒ `- [x]` in the file") is delivered by **`export`**: the
reader now recovers `data-checked`, and the checkbox and the markdown line are the same object. (This is
NOT the same as the existing `groom --write-back`, which is a *legacy* `::ac`-child path — see §4.7.)

## 3. What the code does today (grounding — verified)

- **Default (no `--sync-criteria`) already keeps criteria inline** in `description_html`; export reads
  `htmlToMarkdown(description_html)` back. The redesign changes the HTML *shape* and retires `::ac`.
- **Writer gap** (`markdown/html.ts::markdownToHtml`): `marked` emits GFM `<li><input type=checkbox>…`,
  not TipTap `<ul data-type="taskList"><li data-type="taskItem" data-checked>…`.
- **Reader gap**: the turndown rule fires on `INPUT[type=checkbox]`; Plane's real TipTap output has **no
  `<input>`** (state is `data-checked` on the `<li>`). Verified today: `htmlToMarkdown(<tiptap>)` yields
  `-   first` / `-   second` — **checkboxes lost.** This is the crux of the reverse-sync.
- **AC-splice data-loss bug (existing, must fix)**: `splitBody` returns `{narrative = everything BEFORE
  the AC heading, criteria}` — it does **not** return the SUFFIX after the criteria block. So
  `joinBody(narrative, buildAcceptanceCriteria(...))` (used by `board-story` export rebuild today, and
  planned for migrate) **deletes** any content after the AC block: trailing `### Testing Notes`,
  `**Effort:** …`, `**Depends on:** …`, `**Blocks:** …`. This is a latent bug in export today and a
  blocker for migrate.
- **Long-criterion truncation**: `criterionNameAndBody` caps the child *name* at 255 and puts full text
  in the child *description*; today's export/atlas rebuild read `child.name` only → truncation. Any
  children→criteria recovery must read `child.description` when present.

## 4. Design

### 4.1 Writer — TipTap task-lists via a marked **renderer override** (token-level, not string regex)
Override marked's `list`/`listitem` rendering (token-level, so nested lists, loose/multi-paragraph
items, inline `code`/links/emphasis, and raw text are all handled by marked itself — a string/regex
post-pass over HTML cannot safely do this; Grok F1/F2, Codex #6):
- A list item with `task === true` becomes
  `<li class="todo-list-item" data-type="taskItem" data-checked="true|false"><p>…inline…</p>…blocks…</li>`,
  its inner content rendered by marked (preserving markup and any child blocks/nested lists).
- **Split mixed lists** (Codex #5): a `<ul>` containing both task items and plain items is emitted as
  separate lists — consecutive task items grouped into a `<ul class="todo-list" data-type="taskList">`,
  plain items into a normal `<ul>` — so checkboxes are ALWAYS native even when authored adjacent to a
  plain bullet. Ordered lists and non-task lists are untouched.
- Empty input → `""` (callers skip the field), unchanged.
Rationale for renderer-override over post-pass: robustness to marked's loose-item shape (`<p><input>`)
and nested content; fully unit-testable against pinned output.

### 4.2 Reader — TipTap task-items via a scoped turndown rule (preserve markup, no double-emit)
- New rule scoped to `LI` with `data-type === "taskItem"` (the verified Plane structure): emit
  `- [x] ${content}` / `- [ ] ${content}` where **`content` is turndown's converted child markdown**
  (preserves `code`/links/emphasis; NOT `textContent` — Grok F6, Codex #7), with `data-checked === "true"`
  ⇒ checked (exact string, not any truthy form — Grok F8).
- **Exclusivity** (Grok F5, Codex #7): the existing `INPUT[type=checkbox]` rule must NOT also fire for a
  hybrid `<li data-type=taskItem><input>` — the taskItem rule owns the item and ignores/strips a leading
  input, so no `- [x] [x]` double-marker. Pure-GFM `<input>` (no taskItem ancestor) still uses the INPUT
  rule.
- **Nested task-lists are out of scope** (declared): AC checklists are flat by `splitBody`/`CHECKBOX_LINE`;
  a nested task-list flattens to sibling lines — acceptable and documented (Grok F7).

### 4.3 AC splice — preserve prefix + AC + **suffix** (fixes the data-loss bug)
Add to `markdown/criteria.ts`:
- Extend the body split to expose **`suffix`** = everything from the next heading after the criteria
  block onward. `spliceAcceptanceCriteria(body, criteria)` rebuilds as `prefix + ### Acceptance Criteria
  + rendered checklist + suffix`, preserving the narrative prefix and all trailing sections
  (`### Testing Notes`, `**Effort:**`, `**Depends on:**`, …). (Scope note: free-text lines interleaved
  *among* the checkboxes inside the AC block itself — before the next heading — are not separately
  retained; our AC blocks are checkbox-only by authoring via `CHECKBOX_LINE`.)
- Repoint `board-story.ts` (export rebuild) and migrate to the splice — this removes the existing
  suffix-deletion bug (Codex #4), with a dedicated round-trip test (prefix + AC + `### Testing Notes` +
  `**Effort:**` survives).

### 4.4 Default behavior + `--sync-criteria`
- **Default:** criteria stay inline (already true) and now render as an interactive Plane task-list.
  **Zero** work items per criterion.
- **`--sync-criteria` (sub-item fan-out):** retained for legacy boards only; docs steer to the default.
  **Anti-remint (as built):** `--sync-criteria` is marked DEPRECATED and prints a loud runtime warning
  steering to the default; `doctor`'s `dual` finding is the re-mint backstop. A hard import-time
  `--force` refusal is moot in practice — `--sync-criteria` overwrites the description to narrative-only
  *before* creating children, so simply dropping the flag (what the default does) is the real fix; the
  guard would protect only a user who keeps opting into the deprecated path, for whom the warning +
  doctor detection is proportionate (Grok F18, Codex #9). The `criterion`-label idea is **dropped from
  v1** — it would require a hash-schema bump to force re-touch of skip-unchanged children (Codex #10).
  Per-criterion promotion (`!`/`--promote-criteria`) is a **follow-up**.

### 4.5 Export — description-first, unconditional child exclusion, splice-preserving
- **Unconditionally exclude owned `::ac` children** from the top-level story list (external_source
  `planestories`), NOT only under `--sync-criteria` (Codex #8) — otherwise closed/migrated children
  export as standalone stories.
- Reconstruct each story's criteria **description-first**, fenced on `hasDescriptionChecklist(item)`
  (§2): if the board description has a task-list, the criteria come from `htmlToMarkdown(description_html)`
  (already spliced into the body); **else** fall back to the legacy children rebuild (reading
  `child.description || child.name`, §3) — and that rebuild uses the §4.3 splice so the suffix is
  preserved.

### 4.6 `migrate-criteria` command (idempotent, dry-run default, crash-safe, file+board)
For each parent that has `::ac<n>` children (external_source `planestories`):
1. **Eligibility via a durable predicate** (Grok F9, Codex #1/#2): a parent is **already migrated** iff
   its board description contains a task-list (`data-type="taskList"`). Migrated parents are excluded
   from the fold entirely (only their leftover *open* children are closed), so `--limit` always advances
   and re-runs converge.
2. For an **un-migrated** parent, derive criteria from **all** `::ac` children captured **before any
   close** (text = `child.description || child.name`; `checked` = current `stateGroup === "completed"`),
   sorted by `::ac` index. **Conflict = fail/report, never guess** (Grok F10, Codex #3): duplicate
   `::ac` index (stale-rename), or an existing inline AC block whose text-set differs from the children,
   is reported and skipped — no positional merge, no dedupe of legitimately-identical criteria.
3. **Write the FILE first** (Grok F12/F21, Codex #11): splice the derived criteria into the linked
   markdown file's `### Acceptance Criteria` (matched by `plane_id`, §4.3 splice, preserving suffix), so
   the file — which `import` treats as authoritative — carries the correct checked states and a later
   import cannot clobber them back to `[ ]`. Board items with **no** linked file get a board-only fold
   (no clobber source) with a warning.
4. Update the **board** description to the task-list (only if changed).
5. **Then close the open children** (reuse groom's completed-state + marker path; never delete → the op
   is reversible and safe to re-run). Ordering file→board→close means a crash leaves children open and
   the description-taskList predicate correct, so re-run is a clean no-op or resumes the close.
- Flags: `--project`, `--files <glob>` (linked story files to reconcile), `--yes` (apply; dry-run
  default), `--limit N` (parents/run), shared rate-limit backoff (395-item groom ≈ 30 min).
- Reports: parents scanned / migrated / skipped-conflict, criteria folded, files updated, children
  closed. Idempotent re-run ⇒ 0 folded / 0 closed.

### 4.7 Legacy coexistence — precedence everywhere, coexistence flagged
- **Everywhere criteria are read**, apply §2 precedence: `packet` (was children-first → description-first,
  Grok F17), `atlas` board builder (§4.8), `board-story`, export (§4.5).
- **`groom --write-back`** (legacy `::ac`→file reverse-sync) is **constrained to legacy parents** (those
  with NO description task-list); on a migrated parent its children are administratively completed and
  would wrongly tick every file box (Codex #9), so it must skip them.
- **`groom`** keeps closing orphaned `::ac` children of Done parents (legacy) unchanged.
- **`doctor`** gains TWO findings (Grok F17, Codex #9): (a) *unmigrated* — a parent has `::ac` children
  but no description task-list; (b) *dual/coexistence* — a parent has open `::ac` children **and** a
  description task-list (needs a `migrate-criteria` cleanup pass). Non-zero exit stays.

### 4.8 Atlas board path (Grok F20)
`buildAtlasFromBoard` builds the criteria ring **only** from `::ac` children today → migrated/default
boards would show **0 criteria** (broken quality overlay/counts). Fix with the same precedence and the
**same fence as §2** — `hasDescriptionChecklist(item)` (description contains `data-type="taskList"`),
NOT child count: when the description has a checklist use
`splitBody(htmlToMarkdown(description_html)).criteria`; else fall back to children. (Migrate retains
closed children, so "no children" would be wrong here — Grok v2 blocker.)

### 4.9 Hashing / skip-unchanged (Grok F14–F16, Codex #10)
- Default criteria live in `descriptionHtml`, so the existing OFF-mode hash already dirties the parent
  on any criterion edit. Correct the earlier overclaim: **only stories whose rendered description
  actually changes shape re-hash** (those with task-lists), not literally "every story"; that one-time
  re-touch is expected, safe, idempotent after.
- Flipping a board from `--sync-criteria` to default (post-migrate) dirties those parents once (narrative
  vs full-body HTML) — expected; documented.
- **UI-normalization thrash risk** (Grok F16): if Plane's editor re-serializes a task-list differently
  from our writer after a human UI edit, imports could thrash. Mitigation kept simple for v1: hash over
  our *intended* render (already true) — board-only cosmetic drift is tolerated until the next import; a
  normalize-before-compare is a possible later refinement, not v1.

## 5. Explicitly NOT changing (forced or fine — brief §5)
Epic = parent work item (typed Epics paid); `**Effort:** N.n dev-days` body line + integer `point`
mirror; `**Depends on:** / **Blocks:**` body lines + native `blocked_by`/`blocking` relation sync;
`external_id`/`external_source: planestories` idempotency. (The splice §4.3 exists precisely so these
trailing body lines survive.)

## 6. Testing (red-green, both directions)
- **Writer**: emits `data-type="taskList"`/`taskItem` + correct `data-checked` for mixed checked/unchecked;
  **splits a mixed checkbox+plain `<ul>`** so every checkbox is native; preserves inline `code`/link/emphasis
  and (defensively) a multi-paragraph item; ordered/non-task lists untouched; empty→"".
- **Reader**: recovers `- [x]`/`- [ ]` from **TipTap** taskItem HTML (no `<input>`) AND legacy `<input>`;
  **no double-marker** on a hybrid `<li data-type=taskItem><input>`; preserves child markup; mixed state;
  full `md → TipTap → md` identity for an AC block *including* inline code/link. *(Red first: the
  TipTap-reader test fails on current code — already proven.)*
- **Splice**: `prefix + ### Acceptance Criteria + checklist + ### Testing Notes + **Effort:** + **Depends on:**`
  round-trips with the suffix intact (guards the Codex #4 data-loss bug); board-story export rebuild keeps
  the suffix.
- **Fake client fidelity**: teach `fake-plane-client` to emulate Plane's TipTap normalization (GFM `<input>`
  → `data-checked` task-list, `disabled` stripped) OR drive from a committed real-Plane HTML fixture, so
  import→export tests exercise the real shape.
- **migrate-criteria**: dry-run reports exact counts, writes nothing; apply folds children
  (long text from `child.description`; Done⇒`[x]`) into **both** file and board, then closes open
  children; **idempotent** re-run = 0/0 (predicate = description task-list present); duplicate `::ac`
  index / divergent inline block ⇒ reported+skipped, not merged; a parent with no linked file ⇒ board-only
  + warning; `--limit` advances across runs.
- **Export**: closed `::ac` children never appear as standalone stories (Codex #8); description-first
  recovery; suffix preserved.
- **doctor**: flags both unmigrated and dual-coexistence parents.
- **atlas**: criteria ring populated from the description when no children.
- **`--sync-criteria` anti-remint**: refused (needs `--force`) when the parent already has a task-list.
- **Live proof (DATA — DONE 2026-08-01)**: `migrate-criteria --project "Data Platform"` (dry-run,
  read-only) reported it **would migrate 310 parents, folding 1,578 criteria** into descriptions, with
  correct per-parent open-child close counts — proving the command end-to-end against the real board
  with no mutations (creds never printed). The reader round-trip against Plane's exact TipTap shape is
  covered by unit tests using the brief's probe HTML. The tick-a-box-in-the-UI round-trip is an operator
  step (the harness can't tick a Plane UI box).

## 7. Rollout / risk
- **Sequence is internal to `migrate-criteria`** (file+board+close in one command), so there is no unsafe
  "migrate then import clobbers" window (Grok F12, Codex #11): the file is written authoritative first.
- Existing `::ac` boards keep working (groom/doctor/legacy write-back constrained to legacy parents);
  migration is opt-in, reversible (children closed not deleted), and conflict-fails rather than guessing.
- One-time re-touch of task-list stories on first import (HTML shape) — expected, idempotent after.
- Rate limits: `migrate-criteria` batches with `--limit` + shared backoff.

## 8. Build order (incremental, each with its own red-green tests + pair review)
1. **Splice + reader + writer** in `markdown/{criteria,html}.ts` (the pure conversion core; highest-value,
   fully unit-testable; fixes the data-loss bug and the reader gap). Repoint `board-story` export rebuild
   to the splice.
2. **Export precedence + unconditional child exclusion**; **atlas** + **packet** description-first fallback.
3. **`migrate-criteria`** (file+board+close, idempotent, conflict-fail) + fake-client TipTap fidelity.
4. **doctor** dual findings + **groom write-back** legacy-gating + **`--sync-criteria`** anti-remint guard.
5. Docs (`USING_WITH_CLAUDE.md`, changelog) + live DATA proof.
