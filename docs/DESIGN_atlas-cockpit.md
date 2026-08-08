# Design spec: the Atlas "Cockpit" — nebula→worlds LOD, instruments, dossier sidebar

**Status:** DESIGN COMPLETE + operator-approved (2026-08-08, "This is awesome and I want you to build it").
**Reference implementation:** `~/atlas/atlas-prototype.html` (v4) — a fully-working interactive mockup on a
synthetic 47-epic/742-story board. **It is the spec.** Every constant, easing, and interaction below is
implemented there in the SAME idioms as the production renderer; port it, don't re-invent it.
**Superseded mockups** live in `~/atlas/archive/` (history only). `~/atlas/data-platform-atlas.html` is the
CURRENT production renderer's output on the live board (the "before").

## 0. What this replaces, and what it must NOT break

This is a rewrite of the **presentation + chrome** of `src/atlas/render.ts` (the STYLES/HTML/SCRIPT template).
It does NOT change: `renderAtlasHtml(graph)`'s public contract, the force-layout physics (seed, REP/SPRING/
GRAV, epic-pair 7x repulsion, dynamic parent rest `epicR+16`), the self-contained-offline constraint (no CDN,
no external fonts — system font stacks only), the CLI (`atlas` command, `--no-dependencies`), or the model
(`src/atlas/model.ts`) — except two small model ADDITIONS (§7). The old visual layer (RGY stars, white epic
discs, GFM legend, Color-by dropdown, light theme) is REPLACED.

## 1. The design in one paragraph

A deep-blue celestial navigation cockpit. Work items are **planets, never stars** (no diffraction spikes, no
glow-only nodes — the operator explicitly rejected the star tier and the earlier "candy/plastic orb" look).
Each epic is a dark **void-core hub** wearing a **segmented ring** (one tick per story, lit when done) with its
story count centered and a mono-uppercase name below. Clusters far away render as soft **status-tinted nebulae**
(no individual nodes); as a cluster gains screen room its planets **condense out of the gas**; there is never an
intermediate "star" form. Selection is the only theatrical act: the locked target (story planet OR epic hub)
wears a **rotating dashed amber ring**, an **amber lighthouse beam** sweeps from it, and faint **pulse rings**
expand — nothing else on the board animates loudly (idle board = calm). The header is a bridge-instrument bar
(gauges + live MAG/BRG + a draggable zoom needle on a graduated ruler + the SCAN field). The right sidebar is a
glass panel: a **story view** or an **epic dossier**, plus a NO-TARGET empty state.

## 2. The terraforming ladder (status → world) — the semantic core

| Plane state group | World | Sprite recipe (see prototype `worldSprite`) | Accent hex |
|---|---|---|---|
| `backlog` | Gray cratered rock | base `#a2a8b4`→`#4e535e`, 3 dark craters | `#93a7d1` |
| `unstarted` ("Todo") | **Ice world** (Europa/Hoth) | base `#d8ecf8`→`#5a7d99`, 2 crack lineae + sheen | `#b9dcf2` |
| `started` | Mars | base `#e08a5a`→`#6e3018`, polar cap + dark basin | `#e0824f` |
| `completed` | Earth | base `#57a7e8`→`#123a68`, BOLD green continents `rgba(62,196,118,.95)` + cloud band | `#57a7e8` |
| `cancelled` | Dark cinder | base `#8a4a52`→`#2e181c`, one ember crack | `#f87171` (UI red) |

Narrative: rock (unclaimed) → ice (committed, frozen) → Mars (being terraformed) → Earth (alive); cinder =
extinguished. **The accent column drives EVERYTHING downstream**: nebula tint, ring ticks (lit = Earth-blue
`#5eb2ff`), sidebar status pills/dots, criteria checkmarks (blue, NOT green), epic mini-ring, breakdown bar,
chips (✦ glyphs), contact-list glyphs. **Hue is identity and must survive every zoom** (operator rule after the
green→blue "visual disturbance" complaint — never let a node change hue between LOD tiers).

Features only render at sprite radius ≥7px (auto-degrade to plain shaded spheres below). Every sprite gets a
soft **atmospheric halo** baked in (radial `base+"44"`→transparent at 1.6r) — planetary glow, NOT star glow.

## 3. LOD ladder (per-cluster, not global)

- Driver: `sp = 0.698 * (epicWorldR + firstOrbitGap) * view.scale` — screen-space room per story. Prototype
  uses `+24` (ring layout); production should derive from the force rest length (`epicR+16`) or measured mean
  child distance. **Per-cluster** ⇒ small epics resolve before 50-story monsters (telescopic feel).
- `res = smoothstep(13,22,sp)` — planet alpha; `neb = 1−res`, drawn as `neb*0.85+0.15` (**nebula never fully
  vanishes** — a whisper of cluster atmosphere remains at close zoom; operator-loved detail).
- Nebula = 3 seeded radial blobs per hub: slate-blue base `110,140,225 @ .11`; **done-fraction blob**
  `87,167,232 @ .04+.12*doneFrac` (clusters literally turn Earth-blue as they complete); rust whisper
  `224,130,80 @ .05` iff any started. Plus 3 tiny twinkle sparkles in the gas. Radius from CLUSTER EXTENT —
  in production compute max child distance per epic after settle (not the prototype's ring formula).
- Stories skip rendering entirely when `res≤0.02` — EXCEPT the selected node, which always renders.
- No `L.world` tier anymore (deleted with the star tier). Planets simply scale with zoom.

## 4. Node geometry — SIZE = EFFORT (log, clipped)

`wq = clamp(3.2, 4.6 + 1.5*log2(effortDays), 8.2)`; screen radius
`r = max(2.6, min(wq*2.3, wq*scale*1.9))` (×1.15 on hover). Stories WITHOUT an effort estimate use the
default mid-weight (unknown ≠ small — honest rendering). Flag = small amber triangle at rim (`res>0.5` only).
Hover = thin cyan ring + mono ID tag. Epic hub screen radius `er = clamp(11, epicWorldR*scale*1.9, 30)`;
count text `max(9, er*0.42)px` mono; label mono-650-10px UPPERCASE below, greedy-decluttered (largest-first,
rect collision, selected/hovered always win).

## 5. Color law (strict, the refinement backbone)

- **Amber `#ffb054` = attention ONLY**: selection ring/beam/pulses, flag sparks, FLAGGED gauge.
- **Cyan `#6ee7ff` = chrome/instrument ONLY**: IDs, counts glow, hover ring, scan pings, needle, UI accents.
- **Orange `#ff9f43` = blocks lanes** (bright golden dashes; verified distinguishable from darker rust Mars —
  if operator ever objects, fallback = red-coral lanes). **Purple `#a78bfa` = relates lanes** (short dashes).
- Status hues per §2 table. No color does two jobs. Dark theme ONLY (cockpit is inherently dark; the old
  light theme + theme toggle + Color-by dropdown are RETIRED — deliberate losses, revisit only if missed).

## 6. Interactions (all implemented in the prototype — port faithfully)

- **Click planet** → lock story (sidebar story view). **Click hub ring** → lock EPIC + fly-to-frame its
  cluster (`s = 66/(0.698*(epicR+24))` world-tier). **Click empty** / ✕ / Esc → unlock (NO TARGET state).
- **Selection pulsar**: beam = rotating wedge (`rot = t*0.00045`, ±0.10 rad, radial gradient
  `rgba(255,176,84,.20)`→0 over 170px, composite `lighter`); pulses = two phases `(t*0.00042+{0,.5})%1`,
  radius `10+p*110`, alpha `.30*(1−p)`; dashed ring `[6,5]` offset `−t*0.035` + faint outer ring.
- **SCAN loop**: type (≥1 char opens CONTACT LIST; camera fit-to-contacts only at ≥2 chars, animated, world
  bbox +60 pad, 56px screen gutter) → matches stay bright, everything else dims (nodes ×0.22, hub/nebula of
  match-less clusters ×0.3–0.35, lanes ×0.3) → one-shot cyan ping rings (700ms) on query change → ↑↓ walk
  (6 rows shown + "…AND N MORE"), **⏎ intercept** = fly `flyToNode(n, mag 6)` + lock + end scan → **Esc
  restores the exact pre-scan viewport** (saved on first keystroke). `/` focuses scan globally. Contact rows:
  status-colored ✦, mono ID cyan, matched substring highlighted cyan (regex-escape the query!).
- **Camera**: `flyTo` = 520ms cubic ease-out on {scale,x,y}; wheel cancels anim; wheel floor
  `min(0.04-ish fit, current)` — **never snaps IN on zoom-out below floor** (Codex-caught bug, keep fixed);
  max `fitScale*40`. Fit uses **screen-space gutter 56–64px** (never world-unit padding).
- **Instruments (all LIVE)**: MAG = `scale/fitScale` ("1.00×" at fit); BRG = pan bearing from drag vector
  (≥8px); needle position = `log(mag)/log(40)` fraction along ruler; **ruler drag = zoom** (center-anchored),
  **dblclick = fit**; PNG button = real `toDataURL` download; FIT button = animated fitAll.
- **Epic dossier sidebar** (real data all exists in production): mono `ID · EPIC`; title; progress card
  (miniRing SVG: ≤12 stories = per-tick segments, >12 = track + fraction arc, count text centered); status
  breakdown BAR (flex spans, widths %, colors §2) + counts line; **Effort TOTAL / REMAINING dev-days**
  (remaining = started+unstarted+backlog Σ); boundary supply lines (deps crossing the epic subtree, role =
  Blocks/Blocked by/Relates + other side's id + epic label); **HEAVIEST STORIES** top-5 by effort, rows
  clickable → `select(story) + flyToNode(story, 8)`; "…AND N MORE IN ORBIT"; Open in Plane.
- **Story sidebar** (locked design from earlier fusion round): mono `ID · USER STORY`; title; status pill
  (dynamic hue); Effort/Priority cells; label chips; epic card (name + done/total + miniRing); acceptance
  criteria list with blue check circles + "N of M" heading; supply lines cards; Open in Plane.

## 7. Production adaptation notes (the non-obvious deltas from the mock)

1. **Model additions** (`src/atlas/model.ts` + tests): `AtlasNode.effortDays` (from `parseEffortDays` on the
   body/description — function exists in `markdown/directives.ts`) and `AtlasNode.priority`. Both flow from
   file AND board sources. Update `atlas/quality.ts`? No — quality is unchanged.
2. **Layout stays force-directed** — the mock's ring layout was synthetic. Nebula radius + LOD spacing must be
   derived from ACTUAL settle positions (per-epic max/mean child distance; recompute on reheat, cache).
3. **Minimap: KEEP** (mock omitted it; production has it and it's essential at 789 nodes). Restyle: nebula-
   colored cluster dots + cockpit border; keep click/drag-to-pan.
4. **Keyboard shortcuts: keep** F fit · R reheat · D deps-only · / scan · Esc (Esc priority: end-scan →
   unlock). Deps-only mode: keep, chip-toggled ("◆ Supply lines" chip in the mock is decorative — wire it).
5. **Filter chips**: wire to existing `state.statusOn/labelOn/flaggedOnly` — add `unstarted` ("todo") chip.
6. **Tooltip**: production's DOM tooltip may stay, but the canvas hover ID-tag covers most of it — builder's
   call; keep whichever reads cleaner (don't ship both).
7. **`epicProg`/dossier data**: compute from graph children client-side (all present once effortDays lands).
   "Open in Plane" uses existing `url` fields.
8. **Perf discipline (required)**: planet + nebula-independent sprites are CACHED per (kind, radius-bucket)
   offscreen canvases (`Math.round(r*2)/2` buckets) — this is what makes 742 nodes cheap; NO shadowBlur in
   per-node paths (underglow = wider low-alpha stroke); `lighter` composite only where needed; continuous
   rAF is required (lane dashes/beam) — consider pausing on `document.hidden`. The old settle-loop + on-
   demand-draw architecture changes to an always-on gentle loop.
9. **Tests**: `tests/unit/atlas/render.test.ts` pins strings of the CURRENT template — will need updating
   (self-containment pins MUST survive: doctype, no external URLs, `</script>` escaping, `[hidden]`,
   `renderAtlasHtml` contract). Model additions get red-green tests. The SCRIPT is a template string tsc
   does NOT check — verify via `new Function(scriptBody)` + headless load (zero pageerrors) like all prior
   atlas work.
10. **Live verification workflow** (proven): extract the embedded `const GRAPH = {...}` from
    `~/atlas/data-platform-atlas.html` (balanced-brace scan — see scratchpad scripts referenced in handoff)
    and re-render through the new code for a real-board check WITHOUT the ~11-min rate-limited relations
    fetch; a fresh live pull (`atlas --project "Data Platform"`) runs detached via nohup (box kills long
    foreground tasks).

## 8. Alternatives considered and REJECTED (do not resurrect)

- **Candy/plastic glossy orbs** (specular spheres) — operator: explicitly disliked.
- **A star tier in the LOD** (diffraction spikes) — operator: "visually upsetting… should never turn into
  stars." Deleted; nebula⇄planets only.
- **Green (verdant) + yellow (dune) planets** — superseded by blue Earth + rust Mars with UI accents
  following planet hues.
- **RGY traffic-light node palette** — evolved into the planet palette (blue/rust/ice/gray/red-cinder).
- **Stoneware / Forged / Cyberpunk / Tron material directions** — lost to Reactor×Celestial fusion
  (`~/atlas/archive/design-studies*.html` for history).
- **Always-on constellation lines, per-epic pulsar beams, graticule** — rejected as noise; pulsar became
  selection-only (battery + calm), constellation/cartographer ideas remain optional future hover-reveals.
- **Outsourcing visuals to Claude Design** — rejected: in-repo mockups are working software on real-shape
  data and become the spec directly.
- **Ruler as position indicator** — it is the ZOOM instrument (analog needle paired with MAG digital).
- **`criterion` label on sub-items, per-criterion promote flag** — out of scope (criteria redesign doc).

## 9. Build plan (suggested)

1. Branch `feat/atlas-cockpit`. Model additions + red-green tests.
2. Rewrite the render template (STYLES/HTML/SCRIPT) porting the prototype wholesale; adapt §7 deltas.
   Keep `renderAtlasHtml` signature + self-containment pins. Update render tests.
3. Headless verify: synthetic scale board + real-board re-render; screenshot fit/mid/close/scan/intercept/
   dossier; zero pageerrors; check label declutter + minimap + filters + deps-only.
4. Full gate (biome/tsc/bun test — suite was 415 green at design time).
5. **Grok + Codex pair review** (standing): `scripts/external_review.sh <engine> <workdir> <brief> <report>`;
   GROK_BIN=`$HOME/.grok/bin/grok`; Grok runs sync (~2-4min), Codex NEEDS detached nohup + watcher (10-min
   foreground timeout kills it). Expect BLOCKs — the atlas visual-pop round surfaced 11 real findings; fix,
   re-review to double-APPROVE before merge.
6. Merge (ff-only) → push → fresh live render → deliver HTML to operator → update `docs/ATLAS.md` (currently
   describes the old design — supersede it) + `docs/USING_WITH_CLAUDE.md` atlas paragraph.

## 10. Constants cheat-sheet (mirror of the prototype)

Chrome: bg radial `#0a1024`→`#030510`; panel `rgba(10,16,36,.72)`; line `rgba(120,150,220,.16)`;
ink `#e9efff`; muted `#8b9bc4`; faint `#5d6c95`; mono = `ui-monospace,SFMono-Regular,Menlo,monospace`.
Ring ticks: lit `rgba(94,178,255,α)` + 2.1×-width underglow `.30α`; unlit `rgba(120,160,255,.16)`; gap
0.055 rad (0.02 when >24 ticks); width `max(2.6, er*0.11)`. Lanes: blocks dash `[9,7]` offset `−t*0.03`
+4px underglow pass; relates dash `[3,8]` offset `−t*0.02`. Spokes `rgba(130,155,215,.13·res)`. Background
stars: 240, twinkle `0.28+0.36·|sin(t·0.0005+φ)|`. Beam/pulse/ring constants in §6.
