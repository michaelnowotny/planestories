# planestories — cheatsheet

Every command, one page. Written for a human skimming and for an agent that needs the exact
invocation. Fuller prose lives in [`README.md`](../README.md), the per-area docs
([`ATLAS.md`](./ATLAS.md), [`REPLICATE.md`](./REPLICATE.md),
[`USING_WITH_CLAUDE.md`](./USING_WITH_CLAUDE.md)), and `--help` on any command.

Examples use the installed binary. From a checkout, substitute
`bun run src/cli/index.ts …` for `planestories …`.

---

## The 30-second model

| | |
|---|---|
| **The markdown file owns** | title, body, acceptance criteria, priority, labels, effort, dependencies |
| **The Plane board owns** | status / completion |
| **`import`** | pushes content file → board, and only what actually changed (content hash) |
| **`export` / `groom --write-back`** | bring completion state board → file |

A story is an `##` heading, an optional ```yaml``` block, a body, and `### Acceptance Criteria`
checkboxes. **Every `##` heading is a work item** — never mix design notes into a stories file.

---

## Everyday

```bash
planestories import stories/q1.md                  # create/update; unchanged stories cost 0 writes
planestories import stories/q1.md --dry-run        # field-level diff of what WOULD change
planestories import stories/q1.md --dry-run --check # + validation findings, no board reads beyond one index
planestories import stories/q1.md --status-only    # bulk state transitions only
planestories import stories/q1.md --sync-criteria  # criteria as task-list items in the description

planestories export --project "Data Platform" -o exports/board.md
planestories export --open-only                   # skip completed/cancelled
planestories export --status "In Progress" --status Todo

planestories set DATA-12 --status "In Progress"
planestories set DATA-12 --evidence "abc123; p95 200ms -> 80ms"   # idempotent, append-only
planestories projects                              # identifier + name for --project
```

`import` writes `plane_id` / `plane_identifier` / `plane_url` / `plane_hash` back into the file.
`plane_hash` is what makes a re-import nearly free — `--force` overrides it.

## Read the board

```bash
planestories board fetch --project "Data Platform" # one sweep -> .planestories/board.json
planestories atlas --project "Data Platform"       # -> exports/atlas.html (offline, self-contained)
planestories atlas stories/q1.md                   # from a file, no credentials
planestories atlas --project X --json -o g.json    # the same graph, as data
planestories atlas --project X --no-dependencies   # skip the relation sweep (faster; NOT "no deps")
planestories atlas --project X --refresh           # bypass + atomically replace the matching cache
planestories atlas --project X --stale-ok          # explicitly accept a cache older than 1h

planestories epic DATA-100                         # rollup: status split, completion %, Σ effort
planestories show DATA-123                         # compact one-item answer; no description body
planestories show DATA-123 --json                  # the same answer for scripts
planestories show DATA-123 --refresh               # live re-fetch + cache replacement
planestories ls --label ingestion --open           # fixed predicates compose with AND
planestories ls --epic DATA-100 --blocked --json   # missing epic id exits non-zero
planestories count --epic DATA-100 --open          # always prints numerator + denominator
planestories count --open --group-by status        # status|assignee|label|epic
planestories audit --since 24h --context ce        # my recent writes, each stamped with instance
planestories audit --since 2026-08-23T08:00:00Z --json
planestories packet DATA-123                       # implementable brief for an agent (an epic emits all descendants)
planestories critical-path --project X             # dependency floor in dev-days, slack, biggest lever
planestories critical-path stories/q1.md --json
planestories ready --epic DATA-100 --limit 10       # all blockers closed; highest immediate leverage first
planestories inconsistent --epic DATA-100           # Done with open blockers; ready but not started
planestories blocked --epic DATA-100                # open work + titled unfinished blockers
planestories orphans                                # leaf stories outside the dependency graph
planestories abandoned                              # open leaf work under a cancelled/abandoned epic
planestories ready --json | jq '.items[0].item'     # every graph verb takes --json
```

`ls` / `count` predicates are exactly `--open`, `--status`, `--label`, `--assignee`, `--epic`,
`--flagged`, `--no-estimate`, and `--blocked`; there is no query grammar. Use `atlas --json` + `jq`
for anything outside that surface. Both prefer a matching fresh cache and print its age.
The graph verbs' `--json` carries its own `provenance`; on an incomplete relation sweep they write
**nothing** to stdout and exit non-zero, so a pipeline sees an empty document, never half an answer.

`audit` requires a fresh matching board cache for its bounded item list; run `board fetch` first.
It fetches live activity only for cached items whose `updatedAt` is inside the window. The actor is
the API key's owner (not a distinguishable tool), and comment/relation-only writes may not bump
`updatedAt`; the report states those limits, its exact bound, board identity, and cache age.

## Health & hygiene

```bash
planestories lint stories/*.md                     # offline, 10 mechanical rules; strict by default
planestories lint stories/*.md --warn-only         # downgrade to warnings, exit 0
planestories capabilities --context ce             # read-only deployment feature/dialect probe
planestories capabilities --context ce --json      # the same measured result for scripts
planestories doctor --project X                    # board rot; non-zero on findings (CI gate)
planestories doctor --project X --house-rules      # + missing Effort, prose deps with no relation
planestories groom --project X                     # close orphaned criterion sub-items (dry-run default)
planestories groom --write-back stories/q1.md      # board → file checkbox sync, in place
planestories migrate-criteria --project X          # fold legacy ::ac<n> children into the description
```

`doctor`'s default output is byte-stable on purpose — it is a CI gate, so new findings go behind
a flag.

## Replication & backup

```bash
planestories replicate snapshot --from cloud -p "Data Platform" -o data.snapshot.json
planestories replicate backup   --from cloud -p "Data Platform" --dir backups --retain 14
planestories replicate apply    --to ce --snapshot data.snapshot.json           # dry-run
planestories replicate apply    --to ce --snapshot data.snapshot.json --yes     # journaled, resumable
planestories replicate verify   --to ce --snapshot data.snapshot.json           # the cutover gate
planestories replicate freshness --from cloud --snapshot data.snapshot.json --deep
planestories replicate relink   --to ce --snapshot data.snapshot.json --yes stories/
planestories rename-project --context ce --project OLDID --identifier NEWID --yes
```

**`--from` / `--to` are never inferred.** Every other command will pick a default installation;
this one refuses, because it writes an entire project into whichever one it picked.

Snapshots are also the input to the offline analysis commands:

```bash
planestories trend --dir backups                   # board health over time, zero API calls
planestories diff before.snapshot.json after.snapshot.json
planestories critical-path --from-snapshot data.snapshot.json
```

---

## Choosing an installation (contexts)

```jsonc
// .planestoriesrc.json — committed, NON-secret defaults only
{
  "defaultContext": "ce",
  "contexts": [
    { "name": "ce",    "workspaceSlug": "archimedes", "baseUrl": "https://plane.example",
      "apiRateLimit": "60/minute", "defaultProject": "Data Platform" },
    { "name": "cloud", "workspaceSlug": "myworkspace" }
  ]
}
```

Resolution when `--context` is omitted: **`defaultContext` → the only context → refuse and list
them.** A `defaultContext` naming something that does not exist is a startup error, never a quiet
fallback.

**Credentials.** `PLANE_API_KEY` / `PLANE_WORKSPACE_SLUG` / `PLANE_BASE_URL` apply **only when no
context is in force** — including when one was chosen implicitly. A context uses its own
`PLANE_CTX_<NAME>_*` variables, so a key left in your shell for one installation cannot
authenticate a command aimed at another. `<NAME>` is the context name uppercased with
non-alphanumerics → `_`.

```bash
PLANE_CTX_CE_API_KEY=...        PLANE_CTX_CE_WORKSPACE_SLUG=...
PLANE_CTX_CE_BASE_URL=...
PLANE_CTX_CE_API_RATE_LIMIT="60/minute"
```

When `dialect` is absent, planestories uses a bounded read-only relation probe once per context.
Set `dialect: "issues" | "work-items"` (or `PLANE_CTX_<NAME>_DIALECT`) only to override detection;
an explicit value always wins. An inconclusive probe falls back to `issues` with a warning.

Every board-touching command prints the resolved target and dialect before its main operation:

```
→ plane.example · workspace archimedes · project Data Platform · dialect work-items (detected) · context ce (implicit)
```

---

## Story format

````markdown
---
project: "Data Platform"      # file-level default
---

## As an operator, I want live subsystem health, so that I can act during a pass

```yaml
plane_identifier: HGS-14      # written back by import; do not hand-edit
parent: HGS-2                 # epic
status: In Progress
priority: high
labels: [ingestion]
blocked_by: [HGS-9]
blocks: [HGS-31]
comment: "deployed abc123"    # idempotent evidence note
```

**Effort:** 2.5 dev-days

Body text — the narrative. This is what gets hashed.

### Acceptance Criteria
- [ ] Frames land within 5 minutes
- [x] Failures retry three times
````

`kind: epic` marks an epic; an epic wants a `### Why is this needed?` section and **no** acceptance
criteria of its own. `**Depends on:**` / `**Blocks:**` body lines are parsed into real relations
too — they are not just prose.

---

## Deployment differences

**Community Edition has no server-side work-item filtering** — no PQL, no `count_work_items`. Pull
the board once (`atlas --json`) and query locally. Relations live under `/work-items/` on CE and
`/issues/` on Cloud; planestories detects that relation dialect read-only. Run
`planestories capabilities` for measured support/absence on the configured deployment. Details and
reproductions: [`PLANE_CAPABILITIES.md`](./PLANE_CAPABILITIES.md).

## Things that will bite you

- **Every `##` heading becomes a work item.** Design docs and stories do not share a file.
- **Cached answers always print their age.** Past 1h they refuse unless you re-fetch with
  `--refresh` or explicitly acknowledge the old state with `--stale-ok`.
- **`--no-dependencies` is not "this board has no dependencies."** It skips the sweep; the atlas
  says `skipped`, and the floor shows `—` rather than a number.
- **A dependency floor is a floor, not a date.** It assumes unlimited parallelism, and it reads
  `≥ Nd` whenever connected work is unestimated.
- **Dependency queries refuse a partial relation sweep.** Re-run with `--refresh`, or answer from a
  complete `--from-snapshot <file>`; missing edges never become ready/clean findings.
- **`exports/` is gitignored, and board content belongs there.** It is data, not build output — a
  `git add -A` after a smoke run once committed 49,258 lines of live board content.
- **Never commit credentials.** Committed config holds non-secret defaults; keys live in `.env`.
- **Live-test against a sandbox project**, never a production board.

## Exit codes

`0` success · `1` findings or failure (`lint` strict, `doctor` findings, a `critical-path` cycle,
an unreadable snapshot in `trend`) · `--warn-only` and `--no-fail-on-findings` downgrade to `0`.

## Development

```bash
bunx biome check --write . && bunx tsc --noEmit && bun test   # the gate; keep it green
bun run build                                                 # compile a standalone binary
```
