# Project Atlas — the Cockpit

`planestories atlas` renders your work as an **interactive celestial navigation cockpit** — a single
self-contained HTML file that opens in any browser with no server, no build step, and no network
access. It reads the same two sources the rest of the CLI does: a markdown stories file, or a live
Plane project.

> **Credit.** The idea comes from [Ijonas Kisselbach](https://github.com/ijonas)'s *Project Atlas*
> feature in [linearstories](https://github.com/ijonas/linearstories). This is a ground-up
> reimagining for Plane: a zero-dependency offline artifact, a hand-rolled force-directed layout
> (no D3) settled at build time, and the operator-designed "Cockpit" presentation
> (design record: [`DESIGN_atlas-cockpit.md`](./DESIGN_atlas-cockpit.md)).

## Usage

```
# From a stories file — fully offline, no credentials needed
planestories atlas stories/q1-2026.md --open        # -> exports/atlas.html

# From the live Plane board — reads work items + dependency relations
planestories atlas --project "Data Platform"        # -> exports/atlas.html
```

| Option | Meaning |
|---|---|
| `[file]` | Markdown stories file. Omit it and pass `--project` to render the live board. |
| `-p, --project <name>` | Render a live Plane project instead of a file. |
| `-o, --output <file>` | Output path (default `exports/atlas.html`; `exports/atlas.json` with `--json`). Exports are gitignored — see the export rule in `AGENTS.md`. |
| `--json` | Emit the graph as machine-readable JSON instead of HTML. |
| `--open` | Open the generated file in your default browser. |
| `--no-dependencies` | Board source: skip the per-item relation fetch (much faster, no supply lanes). |
| `-c, --config <path>` | Config file (same resolution as other commands). |
| `--context <name>` | Select a named context from a multi-context config. |

The file source needs no credentials — handy for reviewing a story file in a PR before it ever
reaches Plane.

## The scene

- **Work items are planets, never stars.** Status maps to a terraforming ladder: gray cratered
  **rock** = backlog, **ice world** = todo, **Mars** = in progress, blue living **Earth** = done,
  dark **cinder** = cancelled. Hue is identity and survives every zoom level.
- **Planet size = dev-day effort** on a clipped log scale (from the `**Effort:** N dev-days` body
  line). A story without an estimate renders at the honest mid-weight — unknown is not small.
- **Epics are void-core hubs** wearing a segmented progress ring (one tick per story, lit when
  done), their story count at the centre, and a mono uppercase label (greedy-decluttered).
- **Far away, clusters are nebulae.** Each epic's cluster renders as soft status-tinted gas —
  clusters literally turn Earth-blue as they complete — and its planets **condense out of the gas**
  as it gains screen room (per-cluster level-of-detail measured from the settled layout; small
  epics resolve first). A whisper of nebula remains even at close zoom. Stories with no parent
  epic drift between the clusters, subdued when zoomed out.
- **Dependencies are supply lanes**: blocks = animated golden dashes (with an underglow), relates =
  short purple dashes. The ◆ Supply lines chip (or `D`) focuses the map on the dependency web only.
- **Selection is the only theatrical act**: the locked target wears a rotating dashed amber ring
  while an amber lighthouse beam sweeps from it. Idle board = calm.

## The bridge

- **Instrument header**: EPICS / STORIES / SUPPLY LINES / FLAGGED / **FLOOR** / **NO EST.**
  gauges, live **MAG** (zoom relative to fit) and **BRG** (pan bearing), and a **graduated zoom
  ruler** whose needle you can drag to zoom (double-click = fit). FIT and PNG (capped export)
  buttons.
- **FLOOR** is the dependency floor — the longest chain of blocking work, in dev-days, computed at
  build time by the same code `planestories critical-path` runs, so the picture and the number
  cannot disagree. It reads `≥ Nd` and says **FLOOR (MIN)** when connected stories lack an
  `**Effort:**` line, because the real floor is then higher. It shows `—` rather than a number
  whenever one would be a fiction: no dependency chain at all, a cycle (which makes longest-path
  undefined), a relation sweep that dropped edges, or `--no-dependencies`, where nothing was
  fetched to measure. Hover it for which of those applies.
- **NO EST.** counts the connected, unfinished stories with no effort estimate — the ones that
  make FLOOR a lower bound.
- **SCAN**: type in the scan field (`/` focuses it) to search titles and IDs — stories AND epics.
  A **contact list** drops down (status-glyphed rows, matched text highlighted); the field dims
  everything but matches and pings them cyan. `↑↓` walk the contacts, **⏎ intercepts** (locks +
  flies to the target — an epic intercept frames its whole cluster), **Esc restores the exact
  pre-scan viewport**.
- **Click a planet** to lock a story; **click a hub ring** to lock an epic and fly to its cluster;
  click empty space / ✕ / Esc to unlock. Drag pans; dragging a node moves it and its own cluster
  eases around it — deliberately just that cluster, so touching one story does not rearrange the
  board; wheel zooms (never past fit).
- **Minimap** (top right): the whole field with the viewport rectangle; click or drag to navigate.
- **Chips row**: status groups (✦ in their world hue), labels, one chip per assignee
  (`@name` / `@ unassigned`), ▲ flagged-only, and **? no estimate** — all wired filters that dim
  non-matching planets. The no-estimate chip selects exactly the stories behind the FLOOR (MIN)
  reading, so the gauge's claim and the filter's selection are the same set.

## The sidebar

- **Story view**: mono `ID · USER STORY`, title, status pill (world-hue dot), Effort / Priority /
  Labels cells, spec flags (amber, only when flagged), the parent-epic card (progress mini-ring —
  click to open the dossier), the acceptance-criteria list (blue check circles, `N of M`), supply
  lines as clickable cards, and Open in Plane (board source).
- **Epic dossier**: progress mini-ring + `X of Y complete`, a status-breakdown bar with counts,
  **Effort TOTAL / REMAINING dev-days** (unestimated stories counted honestly, never as zero),
  boundary supply lines (dependencies crossing the epic's subtree), and the **heaviest stories**
  by effort — an **ALL / OPEN** toggle restricts the list to not-yet-completed work, the
  "…and N more in orbit" line click-expands the full list (SHOW FEWER collapses), and rows are
  clickable and fly to the story.
- **No target locked** shows a calm empty state.

Keyboard: `F` fit · `D` supply-lines only · `/` scan · `Esc` end scan / unlock.

## The spec-quality overlay

A light, heuristic pass runs on each story (never on epics) and surfaces gentle flags — a small
amber triangle at the planet's rim and a Spec flags section in the sidebar. Current checks:

- **no acceptance criteria** — the story has none.
- **subjective UI language** — words like *intuitive / clean / modern / beautiful* with nothing
  measurable.
- **unquantified performance** — *fast / snappy / instant* with no number anywhere nearby (a
  numeric threshold like `200ms` suppresses it).
- **weasel words** — *etc / and so on / as needed / handle appropriately*.
- **ambiguous scope** — *various / some / several / a few*.
- **thin description** — criteria exist but the narrative is too short to implement against.

For a rigorous, rewrite-producing review, use the [`/rate-userstories`](./RATE_USERSTORIES.md)
Claude Code skill — the Atlas overlay is only a quick visual signal.

## How it stays self-contained

The generated HTML inlines all CSS, all JavaScript, and the graph data (as embedded JSON, with any
`</script>` in your text unicode-escaped so it can't break out). **The layout is solved when the
file is written, not when you open it** — the page arrives already arranged and draws immediately,
rather than animating its way out of a random starting position while you wait. There are no `<script src>` tags,
no remote stylesheets, and no fonts fetched from a CDN — the strict-CSP-friendly kind of page you
can email, drop in an artifact store, or open on a plane. Nothing is ever uploaded. Sidebar links
only ever carry `http(s)` URLs. The cockpit is dark-only by design.


## Machine-readable output — `atlas --json`

`atlas --json` emits the exact graph the cockpit renders — nodes (id, kind, identifier,
title, status/statusGroup, labels, assignee, effortDays, priority, createdAt, updatedAt,
criteria, quality),
dependency edges (`blocks`/`relates`), and counts — so external tooling and the HTML can
never disagree. That is enforced rather than promised: both artifacts are produced by one
`atlasJsonPayload()`, and a test asserts the emitted file deep-equals the graph embedded in the
page.

`createdAt` and `updatedAt` are ISO-8601 UTC strings for board-sourced nodes. They are `null`
when Plane did not supply the timestamp, and always `null` for a markdown-file source — a file
mtime is not a board timestamp and is never substituted for one.

It also carries **`dependencyCoverage`**: `{"kind":"complete"}`, `{"kind":"partial","failures":N}`
when some relation lookups failed, or `{"kind":"skipped"}` under `--no-dependencies`. Read it
before computing anything from `edges` — a graph missing edges is not a graph with fewer
dependencies, and the difference is the whole reason the field exists.
