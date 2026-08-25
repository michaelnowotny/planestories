# Handover — Codex as driver for planestories

*Written 2026-08-25 by the Claude session that has been orchestrating this work. You are taking over
as the primary builder. This document is the context you need; it is deliberately blunt about what
went wrong, because the failure pattern is the main thing to avoid.*

---

## 1. What planestories is

A Bun/TypeScript CLI that round-trips markdown user stories against a **self-hosted Plane Community
Edition** board. Stories live in markdown; the board holds status. `import` pushes content
file → board; `export` and `groom --write-back` bring completion state board → file.

Plane CE has **no server-side work-item filtering at all** — `?pql=` and `?filters=` return HTTP 400,
`count_work_items` is 404, and this is permanent (the rejection in Plane's source is unconditional;
no query engine ships in the community image). So every filtered question is answered by pulling the
whole board once into a local cache and querying it locally. That constraint is the reason most of
this codebase exists.

Read, in this order:
- `AGENTS.md` — the working rules. Not optional; several were written after specific incidents.
- `docs/PLANE_CAPABILITIES.md` — measured facts about the deployment, with reproductions.
- `docs/HANDOFF.md` §8f — where the current branch stands.
- `docs/CHEATSHEET.md` — every command on one page.

## 2. Your environment is already wired

`.planestoriesrc.json` and `.env` exist in the repo root and are **both gitignored** — verified.
Between them they give you a live connection to the real `Data Platform` board (2662 work items) with
no flags required.

**Never commit either file, and never print the API key.** This repository is public. No credential
has ever reached its history (checked across all of it); keep that true.

Verified working immediately before this handover:

```bash
bun run src/cli/index.ts atlas --refresh
# → Atlas written to exports/atlas.html (49 epics, 808 stories, 80 dependencies, 327 flagged)
# → 885 requests · 2m42s
```

`exports/` is gitignored and board content belongs there. **Never commit board content** — a
`git add -A` after a smoke run once committed 49,258 lines of it.

**Live-test writes only against the `SBOX` / Development Sandbox project.** Reads against
`Data Platform` are fine and encouraged. Do not write to `Data Platform`; it is a real team's board.

## 3. The gate

```bash
bunx biome check --write . && bunx tsc --noEmit && bun test
```

Currently **1109 tests, zero biome findings, tsc clean** on branch
`integrate/edge-case-fixes` @ `49c2252` (pushed). Biome uses TABS, width 100.

`main` is at `a2d8be7` and this branch has **not** been merged, deliberately — see §5.

## 4. What has happened, and the failure pattern you are inheriting

An adversarial edge-case hunt found that the export → edit → import round-trip corrupted boards in
four ways, none needing unusual input. Four Codex-built units fixed those. Then **five review rounds**
ran (Grok and Codex, adversarial, read-only). Every round returned BLOCK on real defects.

Here is the part that matters:

> **The four units built by Codex were largely sound. Every regression in rounds 3, 4 and 5 was in a
> fix written by the Claude session in the main loop — nine `fix:` commits, and each one became the
> source of the next round's finding.**

The concentration is sharper still: **`src/markdown/criteria.ts` took five successive patches**, and
each patch caused the next finding:

| round | finding | caused by |
|---|---|---|
| 3 | CommonMark-legal indented criteria rejected as nested | the original nesting fix |
| 4 | the "shared" classifier was not shared; `splitBody` kept a copy | the classifier extraction |
| 4 | a checkbox two levels deep promoted to a peer | tracking only the latest marker |
| 5 | classification ran past the AC heading into `### Testing Notes` | moving classification earlier |
| 5 | stale containers across a paragraph | the container stack |

**Why those fixes kept failing is context, not skill.** Each was a surgical edit made deep into a
long session, fixing the reported symptom while reasoning about it in isolation — and then the test
was written from the same incomplete model, so it inherited the blind spot. One agreement test
literally read `if (parsed === null) return;`, asserting nothing for the exact case it existed to
cover.

**Your advantage is that you read the whole module cold.** Use it. The instruction that follows from
all of this: when you are handed a defect in one of these modules, **do not patch it** — read the
module, understand the contract, and make it coherent.

## 5. The immediate job

Two modules are patch-saturated and should be made coherent rather than edited again.

### A. `src/markdown/criteria.ts` — criteria-section classification

Two contracts must hold, and they are the whole point:

1. **`splitBody` and `groom --write-back` reach IDENTICAL verdicts.** Write-back numbers checkboxes
   for `::acN`; if it disagrees with the parser about which checkboxes are criteria, it ticks the
   wrong box on someone's board. `peerCheckboxLineIndices` is currently the single classifier and
   `splitBody` consumes it — preserve that property however you restructure.
2. **Peer-vs-nested follows CommonMark list structure**, not a heuristic. A checkbox is nested when
   it sits at or past the content column of an open list container; a container closes when a line
   outdents past it, and a non-list line at lower indentation ends the list.

Every input shape the five rounds surfaced, all currently passing — treat these as the regression
floor, not the specification:

```markdown
- [ ] flat                       peer
  - [ ] indented list (1-3 sp)   peer   (CommonMark allows it)
- [ ] parent
  - [ ] child                    NESTED → refuse
- ordinary bullet
  - [ ] under a bullet           NESTED → refuse
- category
  - subcategory
  - [ ] two levels deep          NESTED → refuse
  - [ ] a                        peers, mixed indentation
- [ ] b
 - [ ] c
### Acceptance Criteria          classification stops at the NEXT heading
- [ ] ship it
### Testing Notes
- browser cases
  - [ ] Safari                   NOT a criterion
- category
  - subcategory

Paragraph ends the list.

  - [ ] criterion                peer again
```

Also true and easy to break: a fenced ` ``` ` block is never criteria; a duplicate
`### Acceptance Criteria` heading is refused with its line number; write-back normalises indentation
to column zero and must stay idempotent (a second pass is a no-op).

### B. `src/cli/commands/graph-queries.ts` + `src/sync/query.ts` — which verbs need relations

Same failure class in a different file. `abandoned` reads hierarchy and ancestor status only;
`ready` / `blocked` / `inconsistent` / `orphans` / `critical-path` / `ls --blocked` read edges. Two
defects came from getting that split half-right:

- the nested-edge refusal was wired into five commands and **missed `ls --blocked`**, which then
  silently omitted a blocked item;
- `abandoned` was told to skip relations — and `abandoned --refresh` then **always failed**, because
  a refresh publishes the cache *every other command reads*, so it must fetch relations even for the
  verb that does not need them. Our own stale-cache message recommends `--refresh`, so following our
  advice hit it.

Make the "which verbs need what" decision explicit and single-sourced, so a future change cannot get
it half-right again.

## 6. Rules that were bought with incidents

These are in `AGENTS.md` in full. The ones most likely to bite you here:

- **An assertion that would still pass with the feature deleted is not a test.** After writing a
  test, revert the fix and watch it go red. Report the red-then-green.
- **A guard nobody has seen fail is not a guard.** Sabotage it once. And **check the sabotage
  actually applied** — a scripted edit whose anchor did not match silently proved nothing, twice.
- **Verify against reality, not against a report.** The gate proves the tests pass, not that they
  test the right thing. Smoke-test the live board.
- **Enumerate every caller and every shared resource before changing an invariant**, then write the
  test from that enumeration rather than from the fix. This is the rule all five rounds would have
  been shorter under, and it is the one that was missing.
- **Never coerce absent/unknown into a valid-looking value** — no `0`, `""`, epoch, `false`.
- **Failures and partials never publish success.**
- **A refusal names what would answer it**, and only routes that actually exist.
- **Branch before the first edit. Never work on `main`.**

## 7. Reachability — how to judge whether a defect is worth fixing

A finding is only blocking if the state is **reachable**: not "the board has one" but "the system can
produce one". **Test it, do not assert it.** This session got that wrong in both directions:

- claimed a pagination state "is not one a correct server produces" → Plane sends it on every
  terminal page, and `board fetch` failed on its first real call with 1033 tests green;
- dismissed nested dependency edges as contrived → Plane's API accepts a parent blocking its own
  child (HTTP 201, verified on the sandbox), and planestories itself would create one from a story
  file.

## 8. Open work after §5

- The recorded P2s in `docs/PLAN_local-query-build.md`.
- `main` is 22 commits behind this branch. Merge only when the modules in §5 are coherent.
- Publishing (`npm publish`) is WebAuthn-interactive and needs the operator. The inherited upstream
  `v1.x` tags have been deleted, so a `v0.6.0` release will be "Latest".
- Deferred by the operator to pre-release: rebrand to `planetickets` and a fresh repository with cut
  history, which also removes the instance hostname and real ticket identifiers from public history.
