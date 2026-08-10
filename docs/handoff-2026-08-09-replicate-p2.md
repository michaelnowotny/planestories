# Handoff 2026-08-09 — build replicate P2 (the core engine)

**To the next session:** you are mid-way through building the planestories REPLICATION ENGINE
(migrate a Plane project between cloud and self-hosted instances, fully programmatic, exact
PROJECT-N identifier preservation). Design is FROZEN and operator-decided; P0 (probes) and
P1 (per-context credentials) are DONE and merged. Your job is **P2: the `replicate` command
core**, then P3 (verify + relink), P4 (rehearsals).

## 1. READ FIRST, in order

1. `finance_csv_importer/external_info/planestories-replication-response.md` — THE design
   authority: v2 architecture (8 phases), fidelity matrix, identifier mechanism, operator
   decision addendum (7 answers, 2026-08-09), build-status footer. It survived a BLOCK-round
   from BOTH review engines; §1 lists what they killed — do not re-introduce those errors.
2. `finance_csv_importer/external_info/planestories-v3-migration-brief.md` +
   `planestories-v3-wishlist-response.md` — the criteria-fold program that runs AFTER
   replication cutover (context; not your job, but your feature unblocks it).
3. `src/config/loader.ts` — P1's per-context contract (PLANE_CTX_<NAME>_*, env-only
   contexts, collision guards). `src/plane/{client,issues}.ts` — the client (429 backoff,
   per-call maxRetries override, A10 ensureComment as the verify-before-replay reference).
   `src/atlas/relations.ts` — the paced sweep. `src/sync/migrate.ts` — house style for a
   phased, idempotent, report-emitting board operation.

## 2. State of the world

- **Repo:** `~/PycharmProjects/planestories`, `main` @ `e9afb3f`, clean, pushed. 462 tests
  green; biome + tsc clean. Bun (`export PATH="$HOME/.bun/bin:$PATH"`, run from repo root so
  `.env` loads).
- **Instances:** CLOUD = bare env in `.env` (workspace `bloomenkohlberg`; `BLOOM` = cloud
  sandbox project; `DATA` = the real 750-item board — READ-ONLY for you, never write it).
  CE = env-only context `ce` (`PLANE_CTX_CE_*` in `.env`; workspace `archimedes` at
  plane.porcupine.works; REAL projects live there — touch ONLY `SBOX`).
  `--context ce` works today: `bun run src/cli/index.ts projects --context ce`.
- **SBOX** (`ace8aef7-e3e4-4fb4-9df1-efd4186816f4`) = CE dev sandbox, safe to wipe; its
  sequence ledger already has 1–5 burned (fine — replication targets are created by the run).
- **P0 probe results (empirical, on the operator's CE):** mid-delete does NOT free a
  sequence number; top-delete does NOT either → max-ever ledger semantics confirmed.
  **Cloud mirror probe on BLOOM: NOT YET RUN** — do it before implementing the return-trip
  claim (same script pattern: `scratchpad/probe_sequence.ts` from the old session is gone;
  rewrite from the design doc — create A,B,C / delete mid / create D / delete top / create E).
- **NEVER print or commit credentials.** Both `.env`s are gitignored; mask keys in any
  command output (`| sed "s/$PLANE_API_KEY/<MASKED>/g"`). `~/plane access.txt` may still
  exist in the operator's home dir (their copy; suggested deletion already).

## 3. P2 — what to build (the design doc is authoritative; these are the load-bearing bits)

**⚠ AMENDED 2026-08-09 (operator, after this handoff was first written): the pipeline is
TWO commands around an on-disk SNAPSHOT FILE** — `replicate snapshot --from <ctx> -o f.json`
(the one expensive paced read; versioned, self-contained, diff-stable JSON incl. sequence
map, archived inventory, dialect, digest) and `replicate apply --to <ctx> --snapshot f.json`
(the entire phased writer, ZERO source reads — retries and writer iteration are free against
the rate limiter; dry-run = file + target probe only). `replicate --from --to` remains as
the one-shot chaining both (file persisted + path printed). Journal binds to the snapshot
digest; freeze is only needed DURING snapshot; a cheap freshness check (counts + max
updated_at vs snapshot) gates CUTOVER, with verify-vs-file as the workhorse. Full rationale:
design doc Addendum 2. Phases within apply: probe → manifests → shell → items → parents →
relations → comments → verify+cleanup. Non-negotiable commitments (operator- and
review-locked):

- **Fail-closed pre-write gate (operator Q5):** feasibility of exact identifiers is decided
  BEFORE any write; if API-only exactness is impossible → abort with the two-flag error
  (`--allow-sql-finalize` / `--no-exact-identifiers`). Never a half-written destination.
- **A10 creates:** work-item create with `maxRetries: 0`; ambiguous failure → reconcile by
  expected identifier + source fingerprint before ANY re-POST (ensureComment is the model).
- **Serial creation, ascending source sequence; placeholders consume gaps; per-create
  sequence assertion; drift = abort, recovery = drop/recreate the run-created target
  project.** Placeholder cleanup is ONE-WAY (journal-recorded UUIDs; never re-enter item
  creation after any placeholder deletion).
- **Target project is CREATED BY THE RUN** (sequence-pristine) with identifier-availability
  check; **source freeze** from snapshot through verify (v1 has NO delta sync — a mid-run
  source write = re-run from fresh snapshot).
- **Journal:** append-only JSONL, run-bound (run id + plan digest + instance ids), fsync,
  exclusive lock; resume reconciles by source-UUID fingerprint, NEVER identifier alone.
- **Archived items are replicated as archived** (operator Q6) — inventory them via their
  dedicated endpoints in the probe; never mistake an archived item's number for a gap.
- **Native `created_at`/`created_by`** where the probe confirms the dialect accepts them
  (operator Q3); provenance footer (approved format, keyed by SOURCE COMMENT UUID) is the
  fallback. external_source/external_id copied VERBATIM.
- **Endpoint dialect per profile:** the probe selects `/issues/` vs `/work-items/` per
  instance (the old family is past announced deprecation but still serves).
- **Relations/comments/parents:** second passes over journal ids; placeholders hard-excluded
  from every post-item phase; relation reads FAIL-HARD (no mostly-complete graphs).

P3 afterward: `verify` (bidirectional set equality, field-complete incl. dates/assignee/
estimate, sanitized-DOM primary + markdown secondary content hash, asset/cross-link audit,
runs pre+post cleanup, optional `--export-file` third opinion) + `--relink-files` (journal →
rewrite plane_id/plane_identifier/plane_url across a markdown corpus — WITHOUT this the
finance cutover breaks; it is not optional) + `rename-project` utility (operator Q2).

## 4. Process you MUST follow (standing)

Feature branch per phase (NEVER commit to main — even docs). Red-green for every behavior.
Gate: `bunx biome check --write . && bunx tsc --noEmit && bun test`. Pair review before
merge: `scripts/external_review.sh <grok|codex> <workdir> <brief> <report>`;
GROK_BIN=$HOME/.grok/bin/grok; Grok sync (~3-5 min); **Codex ALWAYS detached**
(`nohup ... &` + poll for the report file — 10-min foreground timeouts kill it). Expect
BLOCKs — this program's reviews have caught real design killers every single round (see the
design doc §9 and the P1 commit messages). Fix red-green → delta re-review → double-APPROVE
→ A8 ff-merge (fetch origin, verify main unmoved) → push. Plane rate limits: the cloud
side's quota was exhausted twice this session by atlas pulls — pace cloud reads, prefer
BLOOM/SBOX for rehearsal, and never hammer DATA.

## 5. Gotchas that cost this session time

- Backgrounding pitfalls: `cmd1 && cmd2 & cmd3` backgrounds the WHOLE `&&` chain (env vars
  vanish for cmd3); `pkill -f <pattern>` can match your own shell's command line (self-kill,
  exit 143/144). Use `setsid nohup bash -c '...' < /dev/null & disown` with absolute paths.
- Foreground commands are killed at 10 min; `sleep`-chains are blocked — use
  `run_in_background: true` + TaskOutput, or until-loops in a background command.
- bun's `.env` auto-load: explicitly-set env vars WIN over `.env` (that's how inline CE
  credentials worked pre-P1); post-P1, `--context ce` is the clean path.
- The review sandbox is read-only (`EROFS` on /tmp) — Codex cannot run write-dependent
  tests; it says so, that's expected, don't chase it.
- `git commit -F <file>` for messages with backticks; biome reformats with tabs — run it
  before committing, not after.
- The finance repo is on ANOTHER session's feature branch — never touch its git state;
  `external_info/` there is gitignored (handoff files live on disk only).

## 6. After P2–P4 (operator-gated, do not start unilaterally)

The DATA cloud→CE run per the acceptance scenario (design doc §"acceptance"), then cutover
(relink + MCP switch to the stdio server with PLANE_BASE_URL — see design doc §7), then the
finance session runs the criteria fold + orphan backfill ON CE. Also still parked: npm 0.5.0
release (main is ~30 commits past published 0.3.1), item 5/7 wishlist deferrals, BLOOM
sequence mirror probe.
