# `/rate-userstories` — Acceptance Criteria Quality Evaluator

A Claude Code skill that evaluates user stories in a markdown file, grading each story's acceptance criteria on verifiability and quality, detecting contradictions within and across stories, and producing reviewable replacement markdown in the canonical `planestories` format.

## Usage

In any Claude Code session within a project that has planestories installed:

```
/rate-userstories <path-to-markdown-file>
```

### Examples

```bash
# Rate stories in a local file
/rate-userstories stories/q1-2026.md

# Rate stories using an absolute path
/rate-userstories /Users/team/project/userstories.md

# Rate the included template
/rate-userstories templates/user-story.md
```

## What it does

The skill reads a markdown file in the [planestories format](./USER_STORY_FORMAT.md) and produces a structured quality report for every user story in the file.

It is designed for agentic coding workflows, so it does more than assign a score:

- Parses the entire file first, rather than judging stories in isolation
- Checks that each story actually follows the expected `planestories` structure
- Scores each story on clarity and verifiability
- Detects contradictions within a story and across stories in the same file
- Emits replacement markdown blocks that a human can review and then copy back into the source document

## Structural validation

Before grading quality, the skill verifies that each story can be evaluated reliably against the documented format:

- `##` H2 heading for each story title
- Optional fenced `yaml` metadata block immediately after the heading
- Description/body content
- `### Acceptance Criteria` section with checkbox items (`- [ ] ...`)

If a story is malformed or missing acceptance criteria, the skill must fail it explicitly rather than pretending it is merely low quality.

### Evaluation dimensions

Each story is scored on a 0-100% scale across four weighted dimensions:

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| **Specificity** | 30% | Are criteria concrete and measurable? Do they use precise values, counts, or named states? |
| **Testability** | 35% | Can each criterion be verified with a clear pass/fail? Could a QA engineer write a test case from it? |
| **Completeness** | 25% | Do criteria cover the story's scope? Are edge cases, error states, and boundaries addressed? |
| **Description Quality** | 10% | Does the description provide enough context for a developer? |

These dimensions produce the numeric score, but score alone does not determine pass/fail.

## Hard-fail contradiction detection

Contradiction detection is a hard-fail rule, not a weighted scoring dimension.

Any contradiction causes the affected story or stories to fail, even if the numeric score is otherwise 80% or higher.

The skill checks for contradictions at two severity levels:

### Hard contradictions

Same entity, workflow, or feature area with mutually exclusive requirements. These are always hard-fail.

- **Within a story** — title vs description, title vs acceptance criteria, description vs acceptance criteria, and criterion vs criterion
- **Across stories in the same file** — conflicting behavior, routes, timing requirements, auth methods, user permissions, state transitions, retry limits, validation rules, or other product constraints for the same workflow or feature area

Examples:

- Story title says email/password login, but acceptance criteria require SSO-only login
- One criterion requires redirecting to `/dashboard`, while another requires remaining on the login page after success
- One story says reset links expire after 24 hours, while another says they expire after 15 minutes for the same workflow
- Story A says "users can withdraw tokens at any time" but Story B says "all withdrawals are locked during the vesting period" for the same token
- One story requires "contract owner can pause transfers" while another requires "token transfers are permissionless and cannot be blocked by any party"
- Story A says "staking rewards are calculated per block" but Story B says "rewards are distributed on a fixed 24-hour epoch schedule" for the same staking pool

### Tensions

Different domains or features with potentially conflicting assumptions. These are flagged as warnings in the report but do not hard-fail.

Examples:

- One story assumes account data is permanently deleted on closure while a separate audit-trail story assumes transaction history is retained indefinitely
- A gas-optimization story targets minimizing storage writes while a separate event-logging story requires emitting events on every state change

The skill treats contradictions as especially important for agentic development because they produce ambiguous implementation targets and unreliable definitions of done.

## Pass/fail rules

A story passes only if all of the following are true:

- Numeric score is **80% or above**
- No hard contradictions were found within the story
- The story does not hard-contradict any other story in the same file
- The story is structurally valid enough to evaluate

If any of those conditions fail, the story fails. Tensions (warnings) do not cause failure but are reported.

### Anti-patterns detected

The skill flags subjective or unquantified language in acceptance criteria:

- **Subjective UI language** — "easy to use", "intuitive", "nice looking", "user-friendly", "clean UI", "visually appealing", "looks good", "modern design"
- **Unquantified performance** — "fast", "responsive", "smooth", "quick" (without thresholds like "< 200ms")
- **Weasel words** — "should work well", "properly handles", "appropriate", "reasonable", "seamless", "robust"
- **Ambiguous scope** — "etc.", "and more", "as needed", "where applicable", "various"

Each flagged criterion gets an explanation of *why* it fails and a concrete rewrite.

### Style guide recommendation

When UI or visual acceptance criteria are unverifiable (e.g., "the button looks professional"), the skill recommends creating a **style guide** with concrete design rules (hex colors, spacing, typography, component specs) that acceptance criteria can reference instead.

**Before:** "Button looks good and matches the design"
**After:** "Button uses the primary action style defined in the style guide (background: `#2563EB`, text: white, padding: `8px 16px`, border-radius: `6px`)"

## Output format

The report is structured as:

1. **Summary table** — Every story with its score, pass/fail status, and whether it failed due to hard contradiction, tension (warning only), structural issue, or score
2. **Contradictions and tensions** — A dedicated section listing every hard contradiction and tension found, with severity level, affected stories, quoted conflicting statements, and why they conflict. For hard contradictions, the normalization choice (which interpretation the skill picked and which it discarded). For tensions, the risk if both stories are implemented as-is.
3. **Detailed breakdown with inline replacement markdown** — Every failed story gets per-dimension scores, flagged criteria with rewrites, contradiction notes when applicable, suggested additions, and immediately after the breakdown, a full replacement markdown block in the canonical `planestories` format. Placing the replacement inline means the reader sees the diagnosis and fix together rather than cross-referencing a separate section.
4. **Style guide recommendation** — Included only when UI/visual anti-patterns are detected
5. **Passing stories** — Brief listing of stories that passed with one-line notes

## Installation

The skill is a project-local Claude Code command. It is included automatically when you clone the planestories repository — no additional installation is needed.

The skill file lives at `.claude/commands/rate-userstories.md`.

### Using in other projects

To add this skill to any project, copy the skill file:

```bash
mkdir -p .claude/commands
cp path/to/planestories/.claude/commands/rate-userstories.md .claude/commands/
```

The skill works with any markdown file that follows the planestories format (H2 story headings, `### Acceptance Criteria` sections with checkbox lists).

## Replacement markdown requirements

Replacement markdown is intended for human review first and source-document updates second.

The skill should:

- Emit a complete replacement story block, not just rewritten bullet points
- Preserve the canonical structure from [USER_STORY_FORMAT.md](./USER_STORY_FORMAT.md): H2 title, optional YAML metadata, description, and `### Acceptance Criteria` checkbox list
- Rewrite enough of the story to remove ambiguity and contradictions, not just the single offending line
- Emit replacement blocks for all affected stories when a hard contradiction spans multiple stories. All replacement blocks for the same contradiction must be consistent — they must reflect the same normalization choice.
- When resolving a contradiction, the skill proposes one consistent interpretation and explains what was chosen and what was discarded. Example: "Proposed normalization: using 24-hour expiry (from Story A). Discarded: 15-minute expiry (from Story B)."
- Place each replacement block inline, immediately after the story's detailed breakdown, so the reader sees the diagnosis and the fix together

The skill should not assume its rewrite is authoritative product truth. The human reviewer decides whether to accept the proposed markdown and merge it back into the original document.
