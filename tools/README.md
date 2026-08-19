# tools/

## `gen_demo_board.ts` — the synthetic board behind the README screenshots

```bash
bun run tools/gen_demo_board.ts /tmp/helios.md
bun run src/cli/index.ts atlas /tmp/helios.md -o /tmp/helios.html
```

`docs/images/atlas-*.png` must never show a real board. They used to: they were
shot from the operator's live `DATA` project and carried real story titles, which
made them a blocker for open-sourcing. This generator produces a fictional
spacecraft-telemetry program ("Helios Ground Segment", 20 epics / ~244 stories /
~44 cross-epic dependencies) at a scale that exercises the same visuals — LOD
resolving nebulae into worlds, the terraforming status ladder, supply lines
crossing epic boundaries, a dossier with real numbers in it.

It is **deterministic** (a seeded LCG, no `Math.random`), so re-shooting produces
the same arrangement rather than a different-looking galaxy each time.

## Taking the screenshots

Any headless browser works. Load the HTML, wait ~2s for the first paint, shoot:

| Image | How to reach it |
|---|---|
| `atlas-overview` | as it opens |
| `atlas-cluster` | ~8 wheel-zoom steps toward the centre |
| `atlas-scan` | click `#scan`, TYPE (don't `fill`) a fragment — the contact list is built on input events |
| `atlas-dossier` | in `#scan`, type an epic name → `ArrowDown` → `Enter` (the page's own intercept path) |

**The old rig is obsolete and the reason it existed is gone.** It drove Chromium
over the DevTools Protocol in real time because `--virtual-time-budget` starved
the force-directed layout — it never settled, and fit-to-view on degenerate
bounds produced absurd zoom. Since the layout is solved at BUILD time
(`src/atlas/layout.ts`) the page opens already arranged, so an ordinary headless
screenshot is correct. Playwright with the cached Chromium was used for the
2026-08-19 set; nothing about the images depends on that choice.
