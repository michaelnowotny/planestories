# Handoff 2026-08-10 — the replication program is BUILT AND PROVEN; next is the OPERATOR-GATED CUTOVER

**Supersedes `handoff-2026-08-09-replicate-p2.md` (deleted; see git history).** You are
picking up after the overnight session that built P3, ran the full P4 matrix, executed the
DATA→CE acceptance rehearsal green, and overhauled the docs. Everything is merged to
`main` (planestories repo) and pushed.

## 1. READ FIRST

1. `finance_csv_importer/external_info/planestories-replication-response.md` — design
   authority + COMPLETE build-status arc (P0→DATA rehearsal, all nine review rounds,
   what each caught, residuals). The single best orientation document.
2. `docs/REPLICATE.md` (this repo) — the operator contract for
   snapshot/apply/verify/freshness/relink/rename-project.
3. Memory `reference_planestories_tool.md` — current one-screen status.
4. `finance_csv_importer/external_info/planestories-v3-{migration-brief,wishlist-response}.md`
   — the criteria-fold program that runs ON CE after cutover (pin: current main).

## 2. State of the world

- **Repo:** `~/PycharmProjects/planestories`, `main` @ `eb7dc11`, pushed, 567 tests.
  Worktree `~/PycharmProjects/planestories-p2` (branch feat/readme-overhaul, merged) —
  USE THE WORKTREE for any build; the finance session does transient checkouts in the
  main tree while importing stories (check `ps` before touching main-tree git state).
- **Instances:** cloud = bare env AND env-only context `cloud`; CE = context `ce`
  (`PLANE_CTX_CE_*` incl. `PLANE_CTX_CE_DIALECT=work-items`) — all in the gitignored
  `.env` of the MAIN repo; symlink it into the worktree for live runs, REMOVE it before
  any Codex/Grok run in that tree. Never print/commit keys.
- **CE replicas (archimedes @ plane.porcupine.works):** `DATA` ("Data Platform", exact
  2,504-item replica, verify 0 failures — but STALE vs the finance session's ongoing
  epic work) and `BLOOMR` (small rehearsal replica). Both deletable on operator word.
- **Durable artifacts:** `~/plane-replication/` — data.snapshot.json (2,504 items,
  digest 05036c9b2bd1; the first full board backup), its apply journal (matches THAT
  snapshot only), verify reports, `tools/cdp_shoot.ts` (screenshot rig).

## 3. THE NEXT JOB — cutover, ONLY on the operator's explicit signal

The finance session is finishing a big epic on cloud DATA first. When the operator says
go:

1. `replicate freshness --from cloud --snapshot ~/plane-replication/data.snapshot.json
   --deep` — will be STALE (epic work landed). That's expected.
2. Delete the CE `DATA` project (operator-sanctioned as part of cutover; it's the stale
   rehearsal) — or keep it and apply the fresh snapshot with `--recreate-target`.
3. Fresh `replicate snapshot --from cloud -p "Data Platform" -o <new>.snapshot.json`
   (~25 min; board must be quiet) → `replicate apply --to ce --snapshot <new> 
   --assume-gaps-deleted --yes` (~2h: CE PATCH latency dominates parents/comments; rate
   varies in waves — don't diagnose a "stall" under 10 min) → `verify` (0 failures
   required) → `freshness --deep` (must be FRESH — freeze window).
4. `replicate relink --to ce --snapshot <new> --yes <story dirs>` on the finance repo's
   markdown corpus (dry-run first; review the diff with the operator).
5. `.mcp.json` in the finance repo: switch the Plane MCP to the open-source stdio server
   (`makeplane/plane-mcp-server`) with `PLANE_BASE_URL=https://plane.porcupine.works` +
   CE key + slug `archimedes`. Pin exact env names against the installed release.
6. Operator archives/renames cloud DATA (their call; `rename-project` exists).
7. Then the finance session runs the criteria fold + orphan backfill ON CE per the v3
   brief (pin note updated 2026-08-10: run at current main; CE needs the dialect env).

## 4. Load-bearing platform facts (cost hours if forgotten)

- **CE serves relations ONLY under `/work-items/`** (`/issues/` 404s them); NEITHER
  instance serves the archived-items endpoint; CE rejects special characters in project
  names; on the operator's CE build, comment creates DO bump item `updated_at` (other
  versions may not — freshness `--deep` exists for that).
- Verify judges by the JOURNAL (mappings, probe verdicts, journaled member map) — it
  needs the journal from the SAME snapshot's apply; `~/plane-replication`'s journal only
  matches the OLD snapshot.
- Max-ever sequence semantics empirically confirmed on BOTH instances; exact-identifier
  apply asserts every create and poisons on drift; `--recreate-target` is the recovery.
- Residuals (documented, accepted): one in-flight HTTP request can land after journal
  lock loss; live-only verify can't see a foreign item archived post-apply on CE; probe
  `created_by` acceptance can false-positive on single-member workspaces; a foreign item
  with identical title AND no external identity at exactly the expected sequence could
  be adopted (never observed).
- Harness gotchas: `cmd && cmd & cmd` backgrounds the WHOLE chain (bit us 3×) — use
  script files with absolute paths; background monitor loops get killed ~5 min — check
  state, restart loop; virtual-time chromium budgets STARVE the atlas force layout —
  screenshot via the CDP real-time rig (`~/plane-replication/tools/cdp_shoot.ts`).
- README screenshots (docs/images/atlas-*.png) show REAL board content — re-shoot from a
  synthetic board before any open-sourcing.

## 5. Process (standing)

Feature branch per change incl. docs; red-green; gate = `bunx biome check --write . &&
bunx tsc --noEmit && bun test`; pair review via
`finance_csv_importer/scripts/external_review.sh <grok|codex> <workdir> <brief> <report>`
(Grok sync ~3-5 min; Codex ALWAYS detached via setsid nohup + poll; remove the worktree
`.env` first). Expect BLOCKs — across this program every single round caught something
real. A8 ff-merge (fetch origin, verify main unmoved), push. Merge-if-double-approved was
operator-authorized for the overnight; re-confirm scope for new work.

## 6. Parked (operator-gated or design-pending)

npm 0.5.0 release (main is far ahead of published 0.3.1; do after cutover, one clean
story) · scheduled nightly `replicate snapshot` backups (cron + retention; trivial build,
high value) · doctor house-rule lints (wishlist #5) · `import --dry-run` field diff
(wishlist #7) · journal-less verify / snapshot diff+gzip · BLOOMR/DATA replica cleanup ·
suggest the operator delete `~/plane access.txt` if it still exists.
