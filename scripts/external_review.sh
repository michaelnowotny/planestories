#!/bin/bash
# external_review.sh — delegate a code review to an external (non-Claude) model.
#
# Purpose (2026-07-21, operator-directed token-economy program): reviews are the
# platform's biggest Claude-token sink (~150-260K tokens per Opus review-by-
# execution). Delegating the review to an external engine costs the Claude main
# loop only this dispatch + reading the report file (~KBs).
#
# Engines:
#   codex  — OpenAI Codex CLI signed in with the ChatGPT subscription
#            (usage included in the plan; no per-token billing).
#            One-time setup: ~/.local/bin/codex login   (browser OAuth)
#   grok   — xAI Grok Build CLI (`grok`, the official xai-org/grok-build binary)
#            signed in with the operator's SuperGrok / X Premium+ SUBSCRIPTION via
#            OAuth device-code login — NOT an XAI_API_KEY, and NOT xAI's
#            data-sharing free-credit tier (proprietary code would become
#            training data under that tier). Usage is included in the
#            subscription; no per-token billing on this path.
#            One-time setup (operator-run, needs an interactive browser):
#              curl -fsSL https://x.ai/cli/install.sh | bash   # installs to ~/.grok/bin,
#                                                               # symlinks ~/.local/bin/grok
#              grok login --device-auth                        # prints a URL + code;
#                                                               # approve in a browser
#            GROK_BIN below defaults to the ~/.local/bin symlink the installer
#            creates; override via env var if grok only lives under ~/.grok/bin.
#
# Usage:
#   scripts/external_review.sh <engine> <workdir> <brief-file> <report-file>
#
#   <workdir>     the repo checkout / worktree to review (engine runs READ-ONLY)
#   <brief-file>  the review brief (what to check; the diff refs; the verdict format)
#   <report-file> where the engine's final report is written
#
# The engine is instructed to end with "VERDICT: APPROVE" or "VERDICT: BLOCK".
# The caller (Claude main loop) reads ONLY the report file.
set -euo pipefail

ENGINE="${1:?engine (codex|grok)}"
WORKDIR="${2:?workdir}"
BRIEF="${3:?brief file}"
REPORT="${4:?report file}"

CODEX_BIN="${CODEX_BIN:-$HOME/.local/bin/codex}"
GROK_BIN="${GROK_BIN:-$HOME/.local/bin/grok}"


# Exit code 42 = ENGINE QUOTA EXHAUSTED (subscription rate limit). The caller's
# policy (operator-approved 2026-07-21): notify the operator + fall back to a
# Sonnet subagent so the pipeline never stalls; retry the engine later (limits
# reset on rolling windows). Detection is signature-based on the engine log.
quota_check() {
  local log="$1" engine="$2"
  if grep -qiE "rate.?limit|usage.?limit|quota|too many requests|429|limit reached|out of.*(credit|token)" "$log" 2>/dev/null; then
    echo "QUOTA_EXHAUSTED: $engine (see $log)" >&2
    exit 42
  fi
}

case "$ENGINE" in
  codex)
    # --sandbox read-only: the reviewer may run read commands (git diff, tests
    # would need write for caches → keep read-only; brief should ask for static
    # + git-based verification). -C: run inside the target worktree.
    # --output-last-message: the final report lands in $REPORT.
    "$CODEX_BIN" exec \
      -c model_reasoning_effort="${CODEX_EFFORT:-high}" \
      --sandbox read-only \
      -C "$WORKDIR" \
      --output-last-message "$REPORT" \
      "$(cat "$BRIEF")" \
      > "${REPORT}.log" 2>&1 || {
        quota_check "${REPORT}.log" codex; echo "codex exec failed; see ${REPORT}.log" >&2; exit 1; }
    ;;
  grok)
    # Verified flags (grok 0.2.106): -p/--single = headless; no --sandbox flag —
    # read-only is enforced by --disallowed-tools + running in a throwaway
    # worktree. --always-approve lets read tools run unattended.
    "$GROK_BIN" \
      --reasoning-effort "${GROK_EFFORT:-high}" \
      --cwd "$WORKDIR" \
      --disallowed-tools write,edit \
      --always-approve \
      --no-auto-update \
      --output-format plain \
      -p "$(cat "$BRIEF")" \
      > "$REPORT" 2> "${REPORT}.log" || {
        quota_check "${REPORT}.log" grok; echo "grok exec failed; see ${REPORT}.log" >&2; exit 1; }
    ;;
  *)
    echo "unknown engine: $ENGINE" >&2; exit 2 ;;
esac

echo "report: $REPORT ($(wc -c < "$REPORT") bytes)"
