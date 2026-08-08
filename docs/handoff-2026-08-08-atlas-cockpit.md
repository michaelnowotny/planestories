# Handoff 2026-08-08 — build the Atlas Cockpit (design complete, operator-approved)

**To the next session:** you are picking up at the moment the operator said *"This is awesome and I want you
to build it."* The design phase is 100% finished; your job is the production implementation. This doc is your
map; the spec is `docs/DESIGN_atlas-cockpit.md`; the living reference is `~/atlas/atlas-prototype.html`.

## 1. THE TASK

Implement the Cockpit design in the production atlas renderer (`src/atlas/render.ts` + small
`src/atlas/model.ts` additions), per **`docs/DESIGN_atlas-cockpit.md`** — read it FIRST, in full. Then open
`~/atlas/atlas-prototype.html` in a browser (or read its `<script>`) — it is a working implementation of the
whole design on a synthetic 47×742 board, written in the production renderer's idioms specifically so you can
port it. The operator has flown it and approved every element.

## 2. STATE OF THE WORLD

- **Repo:** `~/PycharmProjects/planestories`, branch `main` @ `036b2bf`, CLEAN, synced with origin.
  Suite ~415 green; biome + tsc clean. Bun runtime (`export PATH="$HOME/.bun/bin:$PATH"`; run via
  `bun run src/cli/index.ts …` from inside the repo — its gitignored `.env` holds `PLANE_API_KEY` /
  `PLANE_WORKSPACE_SLUG`; NEVER print or commit them).
- **Merged this arc (all pair-reviewed, pushed):**
  - Criteria-as-tasklist redesign (7 commits, `99baf8f`..`831e5d4`): TipTap task-list writer/reader,
    AC splice (fixed a suffix data-loss bug), description-first precedence, `migrate-criteria` command,
    doctor drift findings, `--sync-criteria` deprecated. Spec: `docs/DESIGN_criteria-as-tasklist.md`;
    report delivered to `finance_csv_importer/external_info/planestories-criteria-redesign-report-2026-08-01.md`.
  - Atlas visual redesign v1 (`036b2bf`): screen-space min node sizes, progress rings, decluttered mono
    labels, softened focus dimming, badge flags, minimap, scan field, keyboard shortcuts. This is what
    `planestories atlas` produces TODAY (see `~/atlas/data-platform-atlas.html` for the live-board "before").
    **The Cockpit REPLACES this visual layer** — `docs/ATLAS.md` describes it and must be superseded when
    you finish (step in the spec's build plan).
- **`~/atlas/`:** `atlas-prototype.html` (THE reference, v4 — planets-only LOD, ice worlds, effort sizing,
  epic dossier, scan loop, live instruments), `data-platform-atlas.html` (current-production render of the
  real board, 2026-08-07 pull — also your GRAPH-extraction source for offline real-data testing),
  `archive/` (superseded mockups; design history only).
- **Parked / deliberately NOT done** (do not do without operator go-ahead):
  - `migrate-criteria --yes` on the live DATA board (dry-run proven: would fold 310 parents / 1578 criteria,
    1 conflict skipped). Parked because another session is actively working the board.
  - npm release of planestories; `ensureComment` idempotency-hardening follow-up ticket.
- **Plane tickets:** planestories work is NOT tracked in the DATA Plane project (single-user tool; tracked
  via repo docs + operator briefs — consistent with all prior planestories work). Nothing in Plane is stale
  from this arc. If the operator asks to track the build in Plane, author stories via the reviewed
  planestories path, not ad-hoc MCP creation.

## 3. PROCESS YOU MUST FOLLOW (standing, operator-adopted)

- **Pair review before merge**: every substantive change reviewed by BOTH engines via
  `scripts/external_review.sh <grok|codex> <workdir> <brief.md> <report.md>` (GROK_BIN=`$HOME/.grok/bin/grok`).
  Write an adversarial brief (scratchpad), demand `VERDICT: APPROVE|BLOCK`. **Grok**: run synchronously
  (~2-5 min). **Codex**: 10-min foreground timeouts are ENVIRONMENTAL — run it detached
  (`nohup … & ` + a background watcher polling for the report file; the harness kills long foreground/
  background tasks but nohup survives). Expect real findings: the two prior atlas/criteria rounds surfaced
  2 BLOCKs + 11 findings and 2 BLOCKs + 7 findings respectively, all genuine. Fix → re-review → double
  APPROVE → ff-merge → push.
- **Red-green**: bug fixes and new model behavior ship failing-first tests. The render SCRIPT is a template
  string tsc does NOT check — validate via `new Function(scriptBody)` + headless Chromium load asserting
  zero `pageerror`s.
- **Headless visual verification**: `bun add -d playwright-core` (chromium already provisioned;
  `chromium.executablePath()`), screenshot, READ the screenshots critically yourself, then
  `bun remove playwright-core && git checkout bun.lock package.json` before committing. Write bun scripts to
  scratchpad FILES (heredocs with apostrophes break shell quoting).
- **Commit trailers** (planestories convention this arc):
  `Co-Authored-By: Claude <model name> <noreply@anthropic.com>` + `Claude-Session: <session url>`.

## 4. GOTCHAS THAT COST TIME (learn from this session)

- The dev box kills long foreground commands (10-min cap) AND background harness tasks — the nohup+watcher
  pattern is the reliable shape for Codex reviews and the ~11-min rate-limited live board pull
  (`atlas --project "Data Platform"` = ~790 per-item relation lookups; some 429s are dropped non-fatally).
- Prefer offline real-data testing: extract `const GRAPH = {…}` from `~/atlas/data-platform-atlas.html`
  with a balanced-brace scanner (respect strings/escapes) and feed it to `renderAtlasHtml` — instant.
- Per-frame canvas cost: NEVER per-node `shadowBlur`/fresh gradients at 742 nodes — sprite-cache per
  (kind, size-bucket); a too-slow rAF page makes Playwright screenshots TIME OUT (that's your tell).
- `backdrop-filter` creates stacking contexts — the header needs `position:relative;z-index:60` or
  dropdowns paint under the sidebar.
- Watch for stray non-ASCII in generated code (two Cyrillic slips happened; one landed inside a hex color).
- Biome formats with tabs and reorders imports — run `bunx biome check --write` before committing;
  amended commits with heredoc messages avoid backtick shell mangling (`git commit -F <file>`).
- tests/unit/atlas/render.test.ts pins template substrings — update alongside the rewrite; keep the
  self-containment pins (no external URLs, escaped `</script>`, doctype).

## 5. DELIVERY RITUAL (what the operator expects)

Iterate with screenshots yourself first; deliver interactive HTML via SendUserFile (display:render) with a
substantive caption; keep `~/atlas/` copies current. The operator reviews by FLYING the artifact and gives
sharp, specific visual feedback — respond with reasoned design judgment (they explicitly value
"think like an industrial designer"), not just compliance. Color-discipline arguments (amber=attention,
cyan=chrome) have repeatedly won them over — keep that rigor.

## 6. AFTER THE BUILD (natural next steps, operator-gated)

Fresh live pull through the new renderer + deliver; update `docs/ATLAS.md` + `USING_WITH_CLAUDE.md`;
consider `migrate-criteria --yes` when the DATA board quiets; optional npm release; possible follow-ups the
operator floated but did not commission: constellation-lines-on-hover, cartographer graticule variant.
