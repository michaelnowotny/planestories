# planestories — guide for coding agents

planestories is a CLI that syncs markdown user stories (with checkbox acceptance criteria)
to [Plane](https://plane.so) work items, both directions. It's a TypeScript/Bun fork of
**linearstories** (Ijonas Kisselbach / Stacking Turtles Ltd., MIT), retargeted from Linear to
Plane's REST API. The point: give coding agents a precise, checkable spec instead of a vague
ticket.

**Plane API reality:** [`docs/PLANE_CAPABILITIES.md`](docs/PLANE_CAPABILITIES.md) — what CE vs
Cloud can and cannot do (no PQL on CE; the two endpoint dialects; relations vs hierarchy). Three
sessions have independently rediscovered these; read it before concluding an API is missing.

**Command reference:** [`docs/CHEATSHEET.md`](docs/CHEATSHEET.md) — every command, its real
flags, and the failure modes, on one page. Start there rather than reading `src/cli/commands/`.

## Working here (must-follow)

- **Bun, not Node.** `export PATH="$HOME/.bun/bin:$PATH"` in every shell, then `bun install`.
  Keep green before any commit — the canonical gate, identical to `docs/HANDOFF.md` §4:
  `bunx biome check --write . && bunx tsc --noEmit && bun test`. (`bun run lint` is the read-only
  variant, `bunx biome check ./src ./tests`.)
- **Biome formats with TABS.** The Edit tool silently fails to match when leading whitespace
  differs — match an inner substring (no leading whitespace) and let `biome --write` reindent,
  or Write the whole file.
- **Tests use a fake client** (`tests/helpers/fake-plane-client.ts`). Any new `PlaneClient`
  method must be added there too, or real-flow tests throw.
- **Live-test only in a SANDBOX Plane project** (creds in the gitignored `.env`) — never a
  production board. `.env` holds real credentials; never print or commit it.

## Review protocol — how a change merges, and how the loop TERMINATES

Substantive changes get an adversarial review from an external engine (`external_review.sh grok
<worktree> <brief> <report>` in the operator's other repo). A reader who did not write the code
finds things the author cannot: one round caught an atlas that **never painted** — a blank page
sitting behind 761 green tests, because nothing executes the embedded script.

That same review also once ran five rounds and sixteen commits. These rules exist so the value is
kept and the loop is not.

**Severity, and what blocks:**
- **P0** — a user hits it on a normal path. Blocks.
- **P1** — the tool tells the operator something FALSE, on a path they use. Blocks.
- **P2 and below** — internal inconsistency, wording, a test that could be stronger, a sibling that
  could be more consistent. RECORD it; do not block. Fix it next time you are in that file.

**Merge when there is no P0 and no P1.** Declare that bar in the brief BEFORE the round. *"No major
problems"* is not a bar — it has no floor, and it is how four rounds became five.

**One round is the default.** Go again only when a round finds a P0/P1 **that a previous fix
introduced**. A regression inside a repair means the change is not understood yet; a residue of P2s
means the reviewer is working and you should stop. (Both real: round 3 found a P0 created by the
round-2 fix commit — worth another pass. Round 4's finding was a P2 promoted to P1 by a brief that
asked for it — not worth one.)

**Never ask the brief for "another instance of the pattern."** Rounds 3–5 each returned an instance
of the same drift pattern because the brief requested one verbatim: *"the highest-value finding you
can give me is a fourth instance."* The engine obliged, and the finding was then read as independent
confirmation the pattern was everywhere. Ask what a USER hits, ranked by consequence. If a pattern is
real it will surface unprompted.

**A brief states** the gate result and the exact SHA, what the previous round found and what you did
about each item, and what you are least sure of. It does not argue for a verdict.

**Trust a reviewer that declines to escalate.** When it says a finding is real but not worth closing
— *"closing it would hide a useful filter on a still-legible map"* — that is judgment, and
overriding it to be thorough is how the loop restarts.

## Board exports go in `exports/` — always

**THE RULE: what the board-reading commands write — `atlas` renders, `export` story files,
`packet` briefs — goes under `exports/` at the REPOSITORY ROOT, and `exports/` is gitignored.
Never commit board content.**

**Replication artifacts are deliberately NOT covered by this rule.** `replicate snapshot -o`,
`verify -o` and `backup --dir` all require an explicit path, and they belong OUTSIDE the repo
(the operator keeps them in `~/plane-replication`) — see `docs/REPLICATE.md`. Do not "helpfully"
relocate them into `exports/`; that would contradict the cutover runbook.

Why, concretely: a `git add -A` after a smoke run once committed **49,258 lines of live board
content** to a feature branch — an `atlas.json` and an `exported-stories.md` sitting in the repo
root, because those were the default output paths. The export carried internal infrastructure
addresses. It was caught in review and purged from history only because the branch had never been
pushed; on a pushed branch it would have been permanent.

Board exports are DATA: large, private to somebody's project, occasionally carrying secrets by
accident. Treat them like a database dump, not like build output.

How the rule is enforced, weakest reliance on memory first:
1. **Every default output path is inside `exports/`** (`src/cli/output_path.ts`), so the common
   case is safe whether or not anyone knows the rule exists.
2. **`.gitignore` covers `/exports/`** — and still covers the old default paths, so a stale
   checkout cannot reintroduce the accident.
3. **An explicit `-o` is honoured but warned about** when it lands inside the repository and
   outside `exports/` — that is the exact shape of the accident. Writing outside the repo (a
   scratch dir, `~/plane-replication`) is legitimate and stays quiet.

When you add a command that writes a file, route it through `resolveOutputPath()`. Do not invent
a new default path.

## Model: two sources of truth

The markdown file owns **content** (title, body, criteria, priority, labels); the Plane board
owns **state/completion**. Import pushes content file→board and only when it actually changed
(content hash). State flows board→file: `export` recovers task-list criteria checkbox state
(`data-checked`), and `groom --write-back` ticks legacy `::ac<n>`-backed checkboxes in place.
Don't blur these.

## Architecture map

- `src/plane/client.ts` — REST client. `request()` wraps every call in transient-failure retry
  (429/5xx/network, `Retry-After` or exponential backoff+jitter; `PLANE_MAX_RETRIES`). Never add
  a parallel HTTP path.
- `src/plane/dialect.ts` — the shared read-only endpoint-family detector and per-context resolver.
  It samples one item and discriminates with relation `GET`; explicit configuration wins, and an
  inconclusive result stays visibly `fallback`, never masquerades as detected.
- `src/plane/capabilities.ts` — independent read-only capability probes with tri-state results
  (`supported` / `not-supported` / `could-not-determine`); powers the `capabilities` command.
- `src/plane/relation_refs.ts` — **the ONE place relation references are normalized.** Plane
  returns them as bare id strings on `/issues/` and as `{project_id, issue_id}` objects on
  `/work-items/`, while the type says `string[]` — so an un-normalized ref becomes an
  `[object Object]` lookup key that matches nothing, and the failure mode is SILENCE, not an error.
  `PlaneClient.getRelations` applies it so every consumer downstream sees bare ids on every
  dialect. **Never normalize in a consumer**: doing it per call site is exactly how five of them
  ended up wrong on CE while one was right (docs/HANDOFF.md §9.5e). Fails closed on an
  unrecognizable shape — a dropped edge is invisible, and an invisible edge gets deleted or
  re-created forever.
- `src/plane/pacer.ts` — optional per-client token-bucket pacing. The configured per-key rate is
  the throughput authority; concurrency is derived from observed latency via Little's Law. Each
  client owns its pacer, so two-instance replication keeps independent budgets.
- `src/plane/issues.ts` — create/update/fetch + `fetchWorkItems`, and `fetchProjectIndex`
  (ONE paginated list → `byId`/`byIdentifier`/`byNormalizedTitle`/`childrenByParent`; the shared
  read that backs the duplicate guard and hashless-linked adopt — never a per-item GET loop).
- `src/plane/resolvers.ts` — name→UUID resolution (project/state/label/member), cached per run.
- `src/sync/` — the verbs: `importer.ts`, `exporter.ts`, `deleter.ts`, `setter.ts`.
  - `content-hash.ts` = `payloadHash()` (pure). `story-hash.ts` = `hashStoryPayload(story, opts)`
    is the **single source of truth** for a story's content hash — importer AND exporter call it
    so write-time and read-time hashes can't drift. Do not inline the hash-field assembly anywhere.
  - `board-story.ts` = `boardItemToStory()` — the one board-item→UserStory conversion, shared by
    exporter (serialize) and importer (reconstruct board state for adopt).
- `src/markdown/` — `parser.ts`/`serializer.ts` (YAML keys incl. `plane_hash`), `writer.ts`
  (`writeBackIds`/`clearWriteBack`), `criteria.ts` (`splitBody`/checklist), `html.ts`
  (`markdownToHtml`/`htmlToMarkdown`).
- `src/cli/commands/` — `import`/`export`/`delete`/`set`/`projects`/`capabilities`/`groom`/`doctor`/`atlas`/`lint`/`packet`/`epic`.
  `src/types.ts` is the type home.
- `src/sync/rollup.ts` — the **epic rollup** (`epic` command). `rollupEpic` reuses packet's
  `collectDescendants`/`isEpic` to summarize an epic: leaf-story status breakdown, completion %
  (cancelled excluded from the denominator), Σ leaf effort + unestimated count, and blocked/blocking
  leaves. Read-only.
- `src/sync/packet.ts` — the **agent spec-packet** builder. `generatePacket` (board wrapper: resolve →
  `fetchProjectIndex` → resolve target by identifier → fetch relations for root+children, bounded) +
  pure `buildPacketStory`/`renderPacketMarkdown`. Emits a self-contained implementable brief (machine-
  readable YAML header + description + AC with board state + dependencies WITH current status + effort +
  parent epic + planning refs). An epic emits itself + every DESCENDANT's brief (nested epics included) and sums descendant dev-days.
  Read-only; stdout or `-o`.
- `src/markdown/directives.ts` — body-line "directive" conventions (`**Effort:**`, `**Depends on:**`,
  `**Blocks:**`). Effort detection runs on the CANONICAL form `htmlToMarkdown(markdownToHtml(splitBody(
  body).narrative))` so `marked` (a real CommonMark engine) owns all code/heading parsing and detection
  can't diverge from the hashed narrative. `parseYamlEffort` / `injectEffortLine` / dependency-directive
  parsing live here.
- `src/sync/relations.ts` — the dependency **reconciliation engine** (a GLOBAL post-create phase over a
  FRESH `fetchProjectIndex`, bounded to concurrency 6). Canonical block-edge keys dedup Plane's auto-mirror;
  removal only when BOTH endpoints are in the import batch AND `external_source=planestories`; SELECTIVE
  cycle handling (skip only cyclic edges, sync the rest); withhold `plane_hash` for skipped-edge stories.
  `src/plane/client.ts` gains `getRelations`/`createRelation`/`removeRelation`.
- `src/lint/` — `rules.ts` (10 offline mechanical rules) + `linter.ts` (parse fileset → run rules →
  exit code). Rules index stories under BOTH an exact and a normalized identifier map; DEPENDENCY
  rules resolve NORMALIZED (matching `relations.ts`). **PARENT CASE IS DELIBERATELY STRICTER THAN
  IMPORT — decided, not open.** `import` normalizes `parent:` through `normalizeIdentifier`
  (`importer.ts`), so `parent: eng-7` really does attach to `ENG-7` on the board; lint resolves
  parents EXACTLY and reports the mismatch as `dangling-reference`. That is intentional: lint is a
  consistency gate over the corpus, and identifier spelling is a thing worth keeping consistent even
  where import would cope. Pinned by `linter.test.ts` → *"parent resolution is exact while dependency
  resolution is normalized"*. **Do not "unify" this** — a half-unification makes the two parent rules
  contradict each other (`dangling-reference` says the parent does not exist while `bad-parent` says
  it exists and is not an epic, about the same parent). If you ever do want them unified, change both
  rules and that test together, deliberately. This entry previously read "either unify or keep it
  deliberate, but do not assume the two agree", which is an open question a reviewer can re-ask every
  round without it ever closing. Reuses the shared raw `classifyFileEpics` from `atlas/model.ts`.
- `src/atlas/` — the **Project Atlas** visualizer (FORCE-DIRECTED dependency graph). `model.ts` builds an
  `AtlasGraph` (nodes + dependency `edges`) from either a parsed file (`buildAtlasFromFile`) or the shared
  `fetchProjectIndex` (`buildAtlasFromBoard(…, relationsById?)` — folds `kind: criterion` children into
  their parent's AC ring; any item parenting a non-criterion child is an epic). Edges: blocked_by/blocks →
  directed `"blocks"`, relates_to → undirected `"relates"`, deduped (mirror + unordered pair), self/dangling
  dropped. `quality.ts` = the light spec-quality overlay.
  - `layout.ts` — **the force simulation runs at BUILD TIME** (`settleLayout`, exported `PHYSICS`).
    The browser receives settled coordinates in `POS0` and draws once. It used to settle in the
    browser at one tick per frame; 325 frames of that was the "unbelievably sluggish" report, and
    the sim being *in the page* is no longer true however natural it reads.
  - `render.ts` — `renderAtlasHtml(graph, { coverage })` → one self-contained HTML (inlined CSS/JS +
    embedded JSON with `</script>` unicode-escaped; NO D3/CDN). **`coverage` is REQUIRED and has no
    default** (`DependencyCoverage` in `model.ts`: `complete | partial | skipped`) — a default of
    "complete" would let a caller publish a floor as fully-observed without saying so. The header
    gauges are computed at build time by the SAME `computeCriticalPath` the CLI uses, never
    re-derived in the browser, and the floor has five states (`ok` / `none` / `cycle` / `incomplete`
    / `skipped`) because each removed one way a cell could read as a measurement it is not.
    Interactive physics survives ONLY as a drag relaxation scoped to the dragged node's own cluster
    (`neighbourhoodOf` — deliberately NOT its dependency partners, which made unrelated clusters
    lurch). A hover **tooltip** is the only innerHTML sink (`esc()`-escaped; the panel uses
    textContent/createElement); a **"Dependencies only"** toggle (`visible()`/`inDeps`) hides
    pure-hierarchy nodes. ALL nodes shown by default; drag/pan/zoom/hover/click-details.
  - ⚠ **No test executes the embedded script** — it is a string here and a program only in a
    browser. `tests/unit/atlas/embedded-script-integrity.test.ts` is the static stand-in (every
    called name declared; nothing assigned that was never declared). Its known holes are listed in
    `docs/HANDOFF.md` §8d. This gap once shipped a page that never painted.
  - The `atlas` command fetches per-item relations (bounded; per-item failures DROP that item's edges
    and become `coverage: partial`; `--no-dependencies` becomes `skipped`, which is NOT the same as
    "this board has no dependencies"). Node ids reset per build (diff-stable). Cockpit design +
    rejected alternatives: `docs/DESIGN_atlas-cockpit.md`.

## House engineering rules (inherited from the operator's other repo, and they apply here)

The operator's market-data platform (`finance_csv_importer`) carries a large rules catalogue built
from real incidents. Most of it is domain-specific (ClickHouse, ZFS, market data) and irrelevant
here. These are the ones that genuinely transfer — they are house rules, not suggestions:

**⚠ First, calibrate.** planestories is a personal CLI: one operator, reversible outputs, no
production dataset behind it, nothing that pages anyone at 03:00. The other repo's heavier machinery
— the A1–A12 catalogue, the three-lane model, schema lockfiles, same-turn board sync, tombstone
registries — does **NOT** apply here, and importing it by analogy is how a two-hour change becomes a
five-round review. That repo says so itself: its three-lane model exists because "the rules catalogue
applied universally converted iteration into administrative burden." A rule that is load-bearing at
4.39 billion rows can be pure ceremony at 800 work items.

**Adding a rule to this file is itself a change with a cost.** State the incident it prevents, or
do not add it. A rule nobody can point to an incident for is a rule that will be selectively ignored,
which is worse than not having it — see the canonical gate, which was mandatory and unpassable for
months while every branch carried "9 pre-existing findings, not mine" as a standing exemption.

- **The three-lookup ritual before you touch anything.** Before changing a module: (1) read the
  module and its neighbours; (2) read its DESIGN doc (`docs/DESIGN_*.md`, `docs/REPLICATE.md`) —
  the "why" and the rejected alternatives live there; (3) `grep` the tests for the symbol. **A
  passing test that asserts the behaviour you are about to call broken is decisive** — check it
  before writing the bug report, not after. The origin of this rule: an agent spent a whole
  investigation "discovering" a defect that three committed documents already explained.
- **A running system tells you what it DOES, never what it is FOR.** Purpose lives in docs and
  tests. Do not infer intent from behaviour alone.
- **Regression-test-first for bug fixes**, with the RED run against unfixed code as the evidence
  step. A test written after the fix, that never failed, proves nothing.
- **Never coerce absence into a valid-looking value** (the null-ban). No `0`, `""`, epoch, or
  `false` standing in for "unknown". Preserve null, omit the field, or return an explicit
  status/note. In this repo the recurring form is a preview or report that invents certainty it
  does not have.
  **SCOPE — values PUBLISHED as claims to the operator:** a number in a report, a gauge cell, a
  `--json` field, a preview line. It does NOT govern ordinary internal defaults, nor a control's own
  cardinality, nor a measured zero. Worked example, because this distinction is what keeps the rule
  finite: on a board where nothing is connected, `unestimated: 0` is a MEASURED zero (the connected
  set is empty, so the count really is zero) and is correct; a *floor* of `0` on that same board is a
  fabricated measurement and is banned. Likewise a filter chip reading "3 no estimate" is exact for
  the control — it selects 3 nodes — even where the board-level claim would be a lower bound. **If
  you cannot state what the value CLAIMS to a reader, this rule does not apply to it.** Applied
  without that scope the rule has no natural stopping point and will generate findings indefinitely.
- **Present-but-invalid configuration fails loudly at startup**; defaults apply only when a value
  is ABSENT. Never silently normalize a broken setting into a working one (see `repo_config.ts`,
  and rule 3 of the installation-defaults work in `docs/HANDOFF.md` §9.6).
- **Failures and partials never publish success.** A failed sweep, a partial page, a lost lock:
  none of them may become an empty-but-healthy result, and no success marker (watermark,
  completion status, `plane_hash` write-back) advances until the work and its publication both
  completed.
- **Retry only classified-transient failures**, and after an ambiguous write, VERIFY durable state
  before replaying it. Blind retry of a POST is how you double-create.
- **Delegate depth, retain adjudication.** Send deep implementation and investigation to a
  subagent or an external engine; keep the overview, the adjudication between disagreeing
  reviewers, and the final decision for yourself. Errors cluster in unsupervised deep dives.
- **Never mask errors in diagnostics.** `2>/dev/null` on an exploratory command once turned a
  failed lookup into a confident false "absent" that was then reported as a finding.
- **One sample is not a measurement**, and **agreement needs a stated reason** — before treating a
  match as verification, say what a MISMATCH would have meant. A backfill that reconciled at
  exactly 100% was once proof of a defect, not of success.
- **Verify state, don't assume it:** check the branch before committing and the SHA after; re-read
  a file before asserting its contents; never switch branches while a test run is in flight.

## Identity / idempotency (load-bearing)

Created items carry `external_source: "planestories"` + `external_id = slug(title)`; criterion
sub-items use `external_id = "<parent>::ac<n>"`. `plane_id`/`plane_identifier`/`plane_url`/
`plane_hash` are written back into each story's YAML. `plane_hash` powers skip-unchanged. **Never
add a `plane_status` key** — `status:` already is the state key.

## Architecture map, continued — the newer subsystems

- `src/sync/writeback.ts` — board→file **checkbox reverse-sync** (`groom --write-back`): pure
  `applyCheckboxStates` + `reverseSyncCriteria` board wrapper. Ticks a story's `- [x]`/`- [ ]` to
  match each legacy `::ac<n>` sub-item's board `stateGroup`, matched positionally, IN PLACE
  (preserves authored text — unlike `export --sync-criteria`, which regenerates the file).
  Dry-run default. Note it is a **file-only, exclusive mode** of `groom`, not additive.
- `src/sync/migrate.ts` — `migrate-criteria`: folds legacy `::ac<n>` CHILD items into the parent's
  description **task list** (the current criteria model — see `docs/DESIGN_criteria-as-tasklist.md`),
  plus `checkCriteriaMigration` (unmigrated / dual-representation drift) which `doctor` reports.
  Board-only, idempotent, dry-run default, conflict-fail, `--only` canary, `--json`.
- `src/sync/graph_check.ts` — board-side DANGLING relation detection (a relation whose target is
  not in the project). Owns the single paced relation sweep and **returns the relations map** so
  other doctor checks reuse it — never add a second sweep. Cycles are not checked board-side
  (Plane silently drops cycle-creating relations; `lint` checks them file-side).
- `src/sync/house_rules.ts` — the opt-in `doctor --house-rules` lints: open non-epic stories with
  no parseable `**Effort:**` line, and board-authored `Depends on:`/`Blocks:` prose whose targets
  have no matching relation (split `missing` vs `unknownTargets`). Consumes the shared relations
  map. **`doctor`'s default output must stay byte-stable** — it is a CI gate; new findings go
  behind a flag.
- `src/sync/story-diff.ts` — the `import --dry-run` field-level diff. It must mirror the apply
  path EXACTLY: the same field guards, the same resolved values (canonical state names, member
  ids, resolved labels, normalized parent identifiers), and the same failure ordering. Unresolvable
  values become NOTES, never phantom field changes. Descriptions compare at the canonical-markdown
  tier (both sides through `htmlToMarkdown`) so Plane's HTML reparse can't fake a body diff.
- `src/config/repo_config.ts` — `.planestories.yml`, a repo-local, committed, NON-secret
  conventions file (distinct from the JSON credentials/context config), discovered upward from cwd.
  v1: `lint.strictness`, `lint.disable`. Present-but-invalid fails loudly; disabled rules are
  printed, never silently dropped.
- `src/sync/setter.ts` — `set --evidence <note>`: append-only, idempotent evidence comments deduped
  by a content-hash marker via `ensureComment`. Works evidence-only (no field change → no PATCH).
- `src/replicate/` — the **replication engine** (whole-project migration between Plane deployments
  with exact `PROJECT-N` preservation). Operator contract: `docs/REPLICATE.md`; rationale and the
  cutover runbook: `docs/HANDOFF.md`.
  - `snapshot.ts` — the one expensive paced read → versioned, digest-bound, deterministically
    ordered JSON (`parseSnapshot` re-verifies the digest and the ascending-sequence invariant).
    Fail-hard: any read failure aborts and writes nothing.
  - `apply.ts` — the phased writer, driven ENTIRELY from the file (zero source reads). Serial
    ascending creates + gap placeholders + a per-create sequence assertion (exact identifiers);
    A10 create discipline (retries off; on an ambiguous create, reconcile by expected sequence +
    a strict fingerprint before ever re-POSTing); adoption requires a provably empty target.
  - `journal.ts` — append-only JSONL, fsync per record, **trailing newline is the commit marker**
    (bytes past the last newline are torn residue and are dropped), pid lockfile with
    non-clobbering restore, and ownership assertions before every append AND every Plane write
    (including inside the client's own retry loop).
  - `verify.ts` — the cutover gate. Journal-anchored (judges by the run's recorded mappings, never
    live guesswork), bidirectional set equality, normalized-DOM description comparison with a
    markdown-tier fallback that downgrades formatting-only differences to warnings.
  - `freshness.ts` — snapshot vs live drift. Item-level = 2 list calls; `--deep` also compares
    comments and relation sets, because comment/relation edits need not bump item `updated_at`.
  - `backup.ts` — dated snapshot + tear self-check + retention prune (atomic no-replace publish via
    temp + `link`; strict per-project filename pattern; prune only after a successful write).
  - `relink.ts` — rewrites `plane_id`/`plane_identifier`/`plane_url` across a markdown corpus from
    the journal mapping (atomic temp+rename). Without it, a cutover leaves every story file
    pointing at dead UUIDs.
  - `probe.ts` — capability + **endpoint-dialect** detection (`/issues/` vs `/work-items/`);
    `create.ts`, `gate.ts`, `instants.ts`, `report.ts` are its supporting pieces.

**State, roadmap, and what shipped when now live in `docs/HANDOFF.md` — deliberately NOT here.**
This file is the durable architecture map; keeping a changelog in it is how it went stale before.

The load-bearing gotchas, alternatives-not-chosen, and Plane-API findings are in
**`docs/DESIGN_DECISIONS_tier1.md`** — READ IT before touching effort/relations/lint. Verified Plane-API
facts: `point` integer-only; integer `point` persists with no estimate system; relations auto-mirror;
**Plane silently drops cycle-creating relations** (server-side backstop). Known limits:
`docs/KNOWN_LIMITATIONS.md`.

**Current state, roadmap, working rules, and the gotcha catalogue: `docs/HANDOFF.md` — the entry
point, read it first.** Design + locked decisions: `docs/DESIGN_DECISIONS_tier1.md` (Tier 1),
`docs/DESIGN_criteria-as-tasklist.md`, `docs/DESIGN_atlas-cockpit.md`; replication contract:
`docs/REPLICATE.md`; full CLI reference: `docs/USING_WITH_CLAUDE.md`.

---

## Bun, concretely

`bun <file>` not `node`/`ts-node` · `bun test` not jest/vitest · `bun install` not npm/yarn/pnpm ·
`bun run <script>` · `bunx <pkg>` not `npx` · prefer `Bun.file` over `node:fs` read/write ·
Bun loads `.env` automatically, so no `dotenv`.

(The generic Bun starter docs that used to fill the rest of this file — `Bun.serve`, WebSockets,
`bun:sqlite`, `Bun.redis`, `Bun.sql`, HTML imports, a React frontend — were ~105 lines describing
APIs this repo does not use even once. planestories is a CLI: no server, no frontend, no database.
They are in the Bun docs if that ever changes.)
