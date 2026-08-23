# Build plan: local query surface (0.6.0)

**Status:** ready to build, 2026-08-23. Design + rationale: [`DESIGN_local-query.md`](./DESIGN_local-query.md).
Deployment facts it rests on: [`PLANE_CAPABILITIES.md`](./PLANE_CAPABILITIES.md).

This is the *implementation* plan — discrete units, each independently dispatchable, each with its
own acceptance criteria and its own tests. Units are ordered so nothing waits on anything below it.

**Baseline:** `main` @ 0.5.0, 820 tests, gate green
(`bunx biome check --write . && bunx tsc --noEmit && bun test`).

---

## Ground rules for every unit

1. **The gate must be green at the end of each unit**, on its own. A unit that leaves the gate red
   is not done.
2. **Tests are part of the unit, not a follow-up.** Every behavioural claim in the acceptance
   criteria has a test. For anything that fixes a bug, the test must have been seen to FAIL against
   the unfixed code first.
3. **Never coerce absence into a valid-looking value.** No `0` for "unknown", no empty result that
   reads like a successful one. This is the rule the whole surface exists to uphold — see the
   `Exported 0 stories` defect it already caught.
4. **A refusal names what WOULD answer the question.** Not "unsupported": either the answer by
   another route, or the exact command that gets it.
5. **Every answer carries its provenance** — which board, and how old the data is. An answer that
   cannot be re-derived later is not evidence.
6. **No new dependencies.** Bun + what is already in `package.json`.
7. **Follow the existing shape.** `resolveGraph` is the single graph-construction path; commands
   register in `src/cli/index.ts`; biome formats with TABS.

---

## Unit 1 — `capabilities`

**Why first:** top-3 for both sessions, smallest thing here, and it retires a class of confusion
that has now cost three sessions several hours each.

**Build:** `planestories capabilities [--context X] [--json]`. Probes the configured deployment and
prints one table.

**Reports:** host · workspace · edition · version · dialect in use · and a MEASURED yes/no for:
relation create, relation list, **relation remove**, PQL, the count endpoint.

**Acceptance criteria**
- [ ] States NEGATIVES explicitly. "relation removal: NOT SUPPORTED on this deployment" is the line
      that matters; a table of only-what-works is a fail.
- [ ] Every row is measured against the live instance, never inferred from version or edition.
- [ ] Edition/version come from `GET /api/instances/` (`instance.edition`, `instance.current_version`).
- [ ] Probes are read-only. **No writes.** Relation create/remove capability is inferred from the
      documented facts plus a `GET`; do NOT create a probe work item to test it.
- [ ] `--json` emits the same data machine-readably.
- [ ] Works when a capability probe itself fails: an unreachable host reports "could not determine",
      never a confident "unsupported".
- [ ] Unit-tested against a stubbed client for: CE (no PQL, no count, no relation-remove) and
      Cloud (all present).

---

## Unit 2 — auto-detected dialect

**Why:** the research machine's entire multi-hour failure was an unset `dialect`. That knob should
not exist for most users.

**Build:** when `dialect` is not configured, detect it once per context and cache it; use it for
every subsequent call in the run.

**Acceptance criteria**
- [ ] An explicitly configured `dialect` always wins — detection only fills an absent value.
- [ ] Detection is one cheap read, not a sweep.
- [ ] The detected value is reported in the target line (`… · dialect work-items (detected)`).
- [ ] Detection failure is not fatal: fall back to the current default and say so.
- [ ] Tested: configured wins; absent triggers detection; detection failure degrades loudly.

---

## Unit 3 — `createdAt` / `updatedAt` on `AtlasNode`

**Why:** finance ranks `createdAt` above every verb. Their retirement archaeology needs "which
tickets were created in window X"; they can do the equivalent for the codebase
(`git log --diff-filter=A`) and have no board equivalent.

**Build:** carry `createdAt` and `updatedAt` through `buildAtlasFromBoard` onto `AtlasNode`, and
into `atlas --json`.

**Acceptance criteria**
- [ ] Both are ISO-8601 UTC strings, or **`null`** when the source does not supply them — never a
      fabricated epoch. (House rule, and the graph already models absence honestly for `effortDays`.)
- [ ] `buildAtlasFromFile` sets both to `null`: a markdown story has no board timestamps, and
      inventing them from file mtime would be a fabrication.
- [ ] Present in `atlas --json`; the HTML embed is unchanged in behaviour.
- [ ] The JSON/HTML agreement test still passes (both come from `atlasJsonPayload`).
- [ ] Tested: board-sourced nodes carry the timestamps; file-sourced nodes carry `null`; a missing
      field stays `null`.

**Explicitly NOT in scope:** cycle time, "what shipped last week", ageing reports. Finance does not
need them and said so; adding them now would be inventing scope.

---

## Unit 4 — `show <identifier>`

**Why:** finance's highest-frequency verb, hand-rolled three times in one day via
`export -i … -o /tmp/x.md` + `grep` (~50 s per run). Also cuts their MCP token burn: the MCP's
`retrieve_by_identifier` returns the whole `description_html` for a five-line question.

**Build:** `planestories show <identifier> [--json]` — one item, human-shaped.

**Prints:** identifier · title · status · effort · priority · assignee · labels · parent (with its
title) · direct children count with status split · relations with each counterpart's **title and
status** · criteria N-of-M. **Not** the description body — that is what `packet` is for.

**Acceptance criteria**
- [ ] Fits on a screen. This is the five-line answer, not a second `packet`.
- [ ] Relations and parent show the counterpart's TITLE, not just its identifier. (Research's
      bucket incident: an identifier alone is true and useless.)
- [ ] A missing identifier exits **non-zero** and says the board it looked on. Usable as a guard in
      a script.
- [ ] Every answer carries provenance: which board, and the data's age when served from cache.
- [ ] `--json` for machines.
- [ ] Tested: known identifier renders the fields; unknown identifier exits non-zero and names the
      board; a relation counterpart's title appears.

---

## Unit 5 — the board cache

**Why:** makes everything above instant and offline, and makes an answer reproducible — two runs
over the same cache describe the same board state.

**Build:** `planestories board fetch [--context X] [--project P]` → `.planestories/board.json`
(gitignored). Read commands prefer it when fresh.

**Acceptance criteria**
- [ ] Every command reading the cache prints its age:
      `→ cached board state · Data Platform · 2662 items · fetched 14m ago`.
- [ ] Past a staleness threshold (default 1h) a command **refuses** rather than silently serving
      stale data, and names the two ways forward (`--refresh`, `--stale-ok`).
- [ ] `--refresh` re-fetches; `--stale-ok` is an explicit acknowledgement. Neither happens by
      accident.
- [ ] The cache records which instance and project it came from; a command targeting a DIFFERENT
      board ignores it rather than answering from the wrong one. **This is the load-bearing one** —
      a cache that silently answers about another instance is the wrong-instance incident again, in
      a new costume.
- [ ] `--from-snapshot` and live `--project` keep working exactly as now; the cache is a third
      source, not a replacement.
- [ ] Tested: age is printed; stale refuses; `--stale-ok` proceeds; a cache from another
      board/project is not used.

---

## Unit 6 — `count` and `ls`

**Why:** contested — research called them least useful, finance ranks them 4th and 5th and already
lost a false claim in a durable register to a missing `count`. Build them small.

**Build:**
```
planestories ls    [--open] [--status S] [--label L] [--assignee A] [--epic E]
                   [--flagged] [--no-estimate] [--blocked] [--json]
planestories count [same predicates] [--group-by status|assignee|label|epic]
```

**Acceptance criteria**
- [ ] Fixed predicates, AND-composed. **No query grammar, no parser, no precedence rules.**
- [ ] `ls` exits **non-zero** when an explicitly named identifier does not exist (the existence
      guard) — consistent with Unit 4.
- [ ] `count --epic X --open` reproduces the number the `epic` rollup gives. A second path to the
      same number that disagrees is worse than not having it.
- [ ] A count always prints its denominator. Research: *"a count is the kind of number that gets
      quoted without its denominator."* `57 open of 69` — never a bare `57`.
- [ ] Both carry provenance and cache age.
- [ ] Tested: each predicate; AND-composition; the denominator; agreement with `epic`.

---

## Unit 7 — `ready` and `inconsistent`

**Why:** research's top pair, and the reason this surface beats PQL rather than substituting for
it. Both are graph problems no row-filter can express.

**Build:**
```
planestories ready        [--epic X] [--limit N]   # open, ALL blockers done, ranked by what it unblocks
planestories inconsistent [--epic X]               # Done items with a non-Done blocker
```

**Acceptance criteria**
- [ ] `ready` excludes anything with an unfinished blocker, and ranks by how many items each one
      unblocks (reuse the `critical-path` leverage computation — do not write a second one).
- [ ] `inconsistent` reports **Done items whose blockers are not Done**. This is the verb that
      finds a WRONG board rather than a slow one; it is the highest-value check in the surface.
- [ ] It also reports the flip side: blockers all Done, nothing started.
- [ ] Both print each counterpart's TITLE.
- [ ] Refuses on an incomplete relation sweep, exactly as `critical-path` does — a dependency answer
      from a partial graph is worse than none.
- [ ] Tested: a blocked item is absent from `ready` and present after its blocker completes; a Done
      item with an open blocker is reported; a partial sweep refuses.

---

## Units 1–8: ALL BUILT and merged (2026-08-23) — the plan is complete

Built by Codex across three dispatches, gate-verified and smoke-tested against the live CE board by
the orchestrator, then reviewed by Grok in one round with the bar declared up front
(P0/P1 block; P2 records). **Verdict: APPROVE — no P0, no P1.**

> *"The load-bearing safety property holds: a cache from board A does not answer about board B on
> any path an operator actually uses. Freshness is labelled or refused. Partials do not publish.
> Failed capability probes do not become confident negatives."*

Measured effect: `show DATA-2469` went from **2m34s / 885 requests** to **0.103s** — the operation
finance runs several times per session.

### P2s recorded, not blocking — fix when next in the file

1. **Relation create/remove capability is a dialect heuristic after a list GET**, not an independent
   measurement. Cloud + an explicitly configured `work-items` dialect would wrongly print
   "relation removal: NOT SUPPORTED". Not a path in use here, but the command's whole purpose is
   not making confident claims from indirect evidence — so this is the first P2 to close.
2. **Cache identity keys on the project SELECTOR, not a UUID.** A rename plus reuse of the old name
   within the staleness window is the one hole; a cross-host cutover does not hit it.
3. **`atlas` artifacts carry no `fetchedAt`.** The command prints the age on stderr, but the HTML/JSON
   file does not, so someone opening `exports/atlas.html` tomorrow cannot see how old it is. Given
   the whole point is that an artifact outlives its stderr, this one matters more than its rank.
4. **`packet` / `epic` / `doctor` / `critical-path` do not read the cache** — they stay live, which is
   honest but means Unit 5's benefit is wired only for `show` and `atlas`.
5. Cache-hit `show` on a missing identifier names the board but not host/workspace.
6. Age text truncates (`90m` → `1h`). Refusal still correct; wording coarse.
7. No `fsync` on cache publish.

## Deferred, with the reason

### `audit` — DECIDED 2026-08-23: the activity endpoint, narrowed by `updatedAt`

**Built in Unit 8.** The implementation requires a fresh schema-v2 board cache, retains a minimal
all-work-item inventory (including criterion children folded out of the atlas graph), and refuses
rather than falling through to a live whole-board enumeration. Its output also states the measured
`updatedAt` caveat: comment/relation-only writes need not bump the parent item, so the bounded result
is evidence rather than a complete activity export.

Measured on CE first, because the answer turned on facts:

| scope | CE |
|---|---|
| `/work-items/{id}/activities/` | **200** |
| `/projects/{id}/activities/` | **404** |
| `/workspaces/{slug}/activities/` | **404** |

Per-item only, but the records carry what is needed: `verb`, `field`, `actor`, `created_at`,
`old_value`, `new_value`, `comment`. Notably this is the ONE surface CE does not degrade.

**Rejected: a local write journal.** `src/replicate/journal.ts` already exists and is battle-tested,
it is free and instant, and it could stamp instance identity at write time. But it records only
writes made *through planestories* — and the incident that motivated this verb was a session of
comments and status transitions posted **through the MCP**. The journal would have been empty for
exactly the session it was needed for, while looking authoritative. A confident, incomplete answer
is the failure class this whole surface exists to prevent.

**Chosen: the endpoint.** It records every write regardless of which tool made it. The cost
objection largely dissolves now that Unit 3 landed `updatedAt`: read the cache, filter to items
updated since `--since`, walk activities only for those. Twenty items touched among forty changed
means forty calls, not 2662.

Two limits to state in the output rather than discover later:
1. **`actor` is the API key's owner.** planestories and the MCP wrapper read the SAME
   `PLANE_CTX_CE_API_KEY`, so they are one actor — and indistinguishable from the key owner's own UI
   clicks. `audit` answers *"which writes by me landed on this instance"*, NOT *"which tool made
   them."* For the motivating incident (which instance?) that is sufficient; say so plainly.
2. **`--since` is required in spirit.** Without a bound it degrades to the full sweep. Default to
   something bounded and print the bound.

**No hybrid.** Journal-for-speed plus endpoint-for-truth is two sources of truth about one question,
which is how you get a fast answer and a correct answer that disagree — a shape this repo has
already paid for four times.
- **`abandoned`** (open items under a cancelled/abandoned parent) — real and urgent for finance's
  retirement register; small once Unit 5 exists.
- **`drift`**, **`orphans`**, **`blocked`** — real, lower frequency.
- **Comment count + last commenter on `AtlasNode`** — research's actual want behind "did anything
  move here"; probably better than `updatedAt` for that question. Needs a payload-size check first.

---

## What must NOT be built

- A query language. If a predicate is not in Unit 6, `atlas --json` + `jq` is the escape hatch, and
  keeping that surface small is the point.
- PQL emulation, or anything that pretends CE can filter server-side.
- Anything reading comment bodies or descriptions into the graph. `packet` owns deep reads.
- `--owner` on `blocked`. Single-operator project; finance called it invented and they are right.
