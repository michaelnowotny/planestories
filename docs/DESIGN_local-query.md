# Design: answering board questions without PQL

**Status:** proposal, 2026-08-23. Not built.
**Context:** Community Edition has no server-side work-item filtering — see
[`PLANE_CAPABILITIES.md`](./PLANE_CAPABILITIES.md). This is the plan for making that a
non-problem rather than a limitation we apologise for.

---

## 1. The premise, and why it is a good position rather than a consolation

The obvious framing is "CE lacks PQL, so we emulate it." That framing is wrong twice.

**First, we already fetch more than PQL could return.** `atlas --json` emits every item with
`status`, `statusGroup`, `labels`, `assignee`, `effortDays`, `priority`, `criteria` (with per-item
checked state), `quality`, and the full dependency edge set. Several of those are *derived by
planestories* and exist nowhere in Plane's data model: effort parsed from a `**Effort:**` body
line, epic-ness inferred from structure, criteria folded from child items, the spec-quality
overlay. A PQL query cannot filter on effort, because Plane does not know what effort is.

**Second, the expensive part is the fetch, and it is a fixed cost.** One sweep of a 2662-item board
is ~2–3 minutes and ~850 requests. Every question after that is a graph traversal over a local
file: microseconds, offline, repeatable, and — importantly — **consistent**, because every answer
describes the same board state rather than a board that moved between queries.

So the design is not "emulate PQL". It is: **fetch once, then answer real questions locally, at
depths a server-side filter could not reach.** A dependency-aware question like "what is ready to
start" is a graph problem; no query language over rows answers it.

## 2. The shape: one cached board state, many cheap questions

```
planestories board fetch                     # one sweep -> .planestories/board.json
planestories ready --epic DATA-2449          # instant, offline
planestories blocked --assignee me           # instant, offline
planestories ls --label ingestion --open     # instant, offline
```

**Freshness is explicit and never silently stale.** Every command that reads the cache prints its
age, and refuses (rather than guessing) past a threshold:

```
→ cached board state · Data Platform · 2662 items · fetched 14m ago
⚠ cached state is 3h old — pass --refresh to re-fetch, or --stale-ok to use it anyway
```

That is the house rule applied to time: a stale answer presented as current is the same defect
class as a fabricated number. `--refresh` re-fetches; `--stale-ok` is an explicit acknowledgement;
neither happens by accident. Commands keep working against `--from-snapshot <file>` and a live
`--project` exactly as they do today — the cache is a third source, not a replacement.

This also makes the **analysis reproducible**: two people (or an agent re-running tomorrow) get the
same answer from the same `board.json`, which matters when the output feeds a decision.

## 3. The commands, grouped by the question — not by the filter

The rule: **a command answers a question a person actually asks.** Where a generic filter is
genuinely wanted, `ls`/`count` provide it with fixed, meaningful predicates rather than a grammar
to learn.

### A. "What should I pick up?" — the one PQL could never answer

```
planestories ready [--epic X] [--assignee A] [--limit N]
```

Open items whose blockers are **all** complete — actionable *now*. Sorted by leverage: how many
other items each one unblocks, and how much it shortens the dependency floor (the `critical-path`
machinery already computes exactly this). This is the flagship: it needs the edge set, effort, and
status together, so it is unavailable server-side on any edition.

### B. "What is stuck, and on whom?"

```
planestories blocked [--epic X] [--assignee A]
```

Open items with at least one unfinished blocker, each shown with its blocker chain and the
blocker's status/owner. Distinguishes three cases that look identical in a raw list: blocked by
open work, blocked by an item that is itself blocked (chain depth), and blocked by a **dangling**
reference (`doctor` already detects these).

**Each blocker prints its one-line TITLE, not just its identifier.** Research session, 2026-08-23,
from a real mis-dispatch: *"`blocked` as specced would have told me CFAP-111 is blocked by CFAP-116.
True, and useless."* CFAP-116 was a bucket of unrelated adjudications; exactly one item inside it
actually blocked the work, and finding that out required reading the body. A bucket is visible as a
bucket the moment you can see its title — and the graph already carries titles, so this costs
nothing and converts a true-but-useless answer into an actionable one.

### B2. "Done, but its prerequisites are not" — the check most likely to catch a real error

```
planestories inconsistent [--epic X]
```

Requested by the research session and **not** in my original list; on their evidence it outranks
`risks` entirely. Two predicates over the edge set:

- **Done items with a non-Done blocker.** Their programme had an arc declared CLOSED on one of two
  pre-declared observation equations; the closure propagated into downstream planning and stood for
  months. Four other headline verdicts were published and cited while the evidence behind them was
  never established. Both are the same graph pattern.
- **Items whose blockers are all Done but which nobody has started** — silently ready. (This is the
  flip side of `ready`, and falls out of the same traversal.)

They would run the first at every session start: *"the query most likely to catch a real error
rather than merely organise work."* That is a better justification than anything on the original
list, because it is the only verb here that finds a WRONG board rather than a slow one.

### B3. "Is anything actually neglected?" — a graph property, not a timestamp one

```
planestories orphans
```

Items that **block nothing and are blocked by nothing** — disconnected from the dependency graph
entirely. This replaces the age-based "stale" idea I proposed, on the research session's direct
refutation: *"age-without-movement is a BAD neglect signal — a ticket open for months is usually
correctly parked behind a real dependency, and ranking by age would surface exactly the wrong items
while burying a two-day-old item that nothing will ever consume."*

They are right, and it is the better idea: it needs no schema change and it is answerable today.

### C. "Where is the risk?"

```
planestories risks [--epic X]
```

Per-epic: unestimated share, blocked share, criteria-completion vs status-completion drift (a story
marked Done with unticked criteria, or the reverse), and single-owner concentration. Every input is
already in the graph; none is available from Plane directly.

### D. The honest filter

```
planestories ls    [--open] [--status S] [--label L] [--assignee A] [--epic E]
                   [--flagged] [--no-estimate] [--blocked] [--json]
planestories count [same predicates] [--group-by status|assignee|label|epic]
```

Fixed predicates, composable with AND, `--json` for machines. **Not** a query language: no parser,
no precedence rules, no reference page. If a predicate is not listed, `atlas --json` plus `jq` is
the escape hatch, and that is a feature — it keeps this surface small.

### E. "Tell me about this one"

```
planestories show DATA-2449
```

One item, human-shaped: fields, parent, direct children with status split, relations with each
counterpart's status, criteria. `packet` already covers the agent-shaped version; `show` is the
five-line answer. Both read the cache when present.

### F. "Do the files and the board agree?"

```
planestories drift stories/*.md
```

Reports where the markdown corpus and the board disagree — status, effort, parent, and especially
**dependency edges**. This is no longer optional: CE cannot delete relations, so any `blocked_by`
removed from a file is a permanent, silent divergence until someone fixes it in the Plane UI. The
tool that creates the divergence should be the one that reports it.

## 4. Hiding the deployment differences — the second half of the ask

A session using planestories should never need to know what a "dialect" is.

```
planestories capabilities [--context ce]
```

Reports, per deployment: edition, version, dialect in use, and a measured yes/no for relation
create / list / **remove**, PQL, and the count endpoint — the exact table three sessions built by
hand. Cheap (a handful of probes) and cacheable per context.

**It must state the NEGATIVES explicitly**, not just list what works — "relation removal:
unavailable on this deployment" is the line that would have saved the research session fifteen
minutes of curl'ing endpoint shapes by hand.

Then the routing becomes automatic:

- **Auto-detect the dialect** on first use and cache it per context, instead of requiring
  `PLANE_CTX_<NAME>_DIALECT`. `replicate probe` already does this detection; it should be promoted
  to a shared, cached capability probe. The research machine's entire failure was an unset dialect —
  that config knob should not exist for most users.
- **Use PQL when it is available** and fall back to fetch-and-filter when it is not, without the
  caller knowing which happened. On Cloud with PQL, `count --status Done` can be one call; on CE it
  is a cache read. Same command, same answer.
- **Never silently degrade a guarantee.** If a fallback changes what the answer means (e.g. an
  approximate count), say so in the output rather than quietly returning a different kind of thing.

## 5. What is NOT answerable today, and what it would take

Honesty about the boundary, so nobody promises these before the data exists.

`AtlasNode` carries no timestamps. So these are **out of scope until the graph is extended**:

- "What changed this week / what shipped in the last sprint"
- "What is stale — untouched for N days"
- "How long has this been In Progress" (cycle time, ageing WIP)

Two of those are the most commonly wanted board questions in any tracker, so this is the highest-
value extension: add `createdAt` / `updatedAt` (and completion time where Plane exposes it) to
`AtlasNode`, at which point `ls --stale 30d`, an ageing report, and a real throughput view all
become local graph traversals. `trend` already covers change-over-time at board granularity from
snapshots; per-item history needs the fields.

Also out of scope by design: anything needing comment bodies or full descriptions (the graph
carries neither, deliberately — it would multiply the payload for questions `packet` answers
better).

## 6. Sequencing

*Re-ordered 2026-08-23 after the research session's scoring. They rated `ls`/`count` LEAST useful
("I do not think in counts, and a count is the kind of number that gets quoted without its
denominator") and `risks` weakest, while adding `inconsistent` as a top-tier want. Their ranking
beats my guesses, so the plan follows it — pending the finance session's, which may differ.*

1. **`capabilities` + auto-detected dialect.** Smallest, and it retires an entire class of
   confusion that has now cost three sessions.
2. **The board cache** (`board fetch`, freshness contract, `--refresh` / `--stale-ok`). Everything
   else is cheap once this exists.
3. **`ls` / `count`.** The convenience gap, and the direct PQL substitute.
4. **`ready` / `blocked`.** The dependency-aware questions — the reason this is better than PQL
   rather than a workaround for it.
5. **Timestamps on `AtlasNode`**, unlocking staleness and ageing.
6. **`risks` / `show`.** Polish.

Steps 1–3 are the ones with a clear brief today. **4 onwards should wait for the answers to
"which questions do you actually reach for?"** — asked of the finance and research sessions on
2026-08-23 — so the verbs match real use rather than my guesses about it.
