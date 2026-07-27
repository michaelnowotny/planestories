# Project Atlas

`planestories atlas` renders your work as an **interactive map** — a single self-contained HTML file
that opens in any browser with no server, no build step, and no network access. It reads the same two
sources the rest of the CLI does: a markdown stories file, or a live Plane project.

> **Credit.** The idea comes from [Ijonas Kisselbach](https://github.com/ijonas)'s *Project Atlas*
> feature in [linearstories](https://github.com/ijonas/linearstories). This is a ground-up reimagining
> for Plane: a zero-dependency offline artifact, a hand-rolled tidy-tree layout (no D3), and a light
> spec-quality overlay.

## Usage

```
# From a stories file — fully offline, no credentials needed
planestories atlas stories/q1-2026.md -o atlas.html --open

# From the live Plane board — one paginated read, same auth as every other command
planestories atlas --project "Data Platform" -o atlas.html
```

| Option | Meaning |
|---|---|
| `[file]` | Markdown stories file. Omit it and pass `--project` to render the live board. |
| `-p, --project <name>` | Render a live Plane project instead of a file. |
| `-o, --output <file>` | Output path (default `./atlas.html`). |
| `--open` | Open the generated file in your default browser. |
| `-c, --config <path>` | Config file (same resolution as other commands). |
| `--context <name>` | Select a named context from a multi-context config. |

The file source needs no credentials — handy for reviewing a story file in a PR before it ever reaches
Plane.

## What you get

- **A tidy tree.** The project is the root; epics hang off it; stories nest under their epics; anything
  without a parent is a top-level node. Layout is a deterministic hand-rolled algorithm — leaves get
  sequential rows, parents centre on their children — so the same input always produces the same file
  (diff-stable).
- **At-a-glance node cards.** Each card shows the title, identifier (e.g. `DATA-101`), a **status dot**
  coloured by state group, an **acceptance-criteria completion ring** (how many ACs are checked), and a
  small **⚠ mark** when the spec-quality overlay flags the story.
- **A details panel.** Click any node for its full title, status, labels, the acceptance-criteria list
  (with checkboxes and completion count), the spec-quality findings, and — for the board source — a
  deep link back to the Plane work item.
- **Filters.** Chips along the top toggle **status groups** (backlog / unstarted / started / completed
  / cancelled), **labels**, and **flagged-only**. Filtering keeps a matching node's ancestor epics
  visible as context and shows a `+N` badge on any epic whose children are hidden.
- **Search.** Free-text match on title or identifier.
- **Pan, zoom, fit, expand/collapse.** Drag to pan, scroll to zoom, and the toolbar has Fit, Expand
  (all), and Collapse (epics). It auto-fits on first load.
- **Theme.** Follows your OS light/dark preference and has a manual toggle.

## The spec-quality overlay

A light, heuristic pass runs on each story (never on epics) and surfaces gentle flags — it is a nudge,
not a gate. Current checks:

- **no acceptance criteria** — the story has none.
- **subjective UI language** — words like *intuitive / clean / modern / beautiful* with nothing
  measurable.
- **unquantified performance** — *fast / snappy / instant* with no number anywhere nearby (a numeric
  threshold like `200ms` suppresses it).
- **weasel words** — *etc / and so on / as needed / handle appropriately*.
- **ambiguous scope** — *various / some / several / a few*.
- **thin description** — criteria exist but the narrative is too short to implement against.

For a rigorous, rewrite-producing review, use the [`/rate-userstories`](./RATE_USERSTORIES.md) Claude
Code skill — the Atlas overlay is only a quick visual signal.

## How it stays self-contained

The generated HTML inlines all CSS, all JavaScript, and the graph data (as embedded JSON, with any
`</script>` in your text unicode-escaped so it can't break out). There are no `<script src>` tags, no
remote stylesheets, and no fonts fetched from a CDN — the strict-CSP-friendly kind of page you can
email, drop in an artifact store, or open on a plane. Nothing is ever uploaded.
