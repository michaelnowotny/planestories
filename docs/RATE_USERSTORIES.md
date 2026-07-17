# `/rate-userstories` — Epic & User-Story Quality Evaluator

A Claude Code skill that evaluates the **epics and user stories** in a markdown file, grading each with a type-specific rubric, validating structure and epic→child hierarchy, detecting contradictions within and across issues, and producing reviewable replacement markdown in the canonical `planestories` format.

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

The skill reads a markdown file in the [planestories format](./USER_STORY_FORMAT.md) and produces a structured quality report for every epic and user story in the file.

Built for agentic coding workflows, it does more than assign a score:

- Parses the entire file first, rather than judging issues in isolation
- Classifies each issue as an epic or a user story from its metadata
- Validates structure and epic→child hierarchy
- Scores each issue with the rubric for its type
- Detects contradictions within an issue and across issues — including epic-to-child inconsistencies
- Emits replacement markdown blocks a human can review and then copy back into the source document

## Classification

The skill classifies each issue from its own metadata, never from its title:

- **Epic** — yaml `kind: epic`, or an exact `Epic` label, or an issue with no acceptance criteria that other issues nest under via `parent`. planestories models an epic as a parent work item.
- **User story** — has a `### Acceptance Criteria` section and is not an epic; may carry `parent: <EPIC-IDENTIFIER>` (e.g. `parent: DATA-12`) nesting it under an epic.
- **Criterion sub-item** — `kind: criterion`; not rated as a standalone story — it is a story's acceptance criterion.

`export` stamps `kind: epic` and `parent:` automatically (an item that parents a real story is emitted as an epic), so tool-produced files self-annotate. Hand-authored files may omit these — when a multi-issue file has no epic and its first issue scopes the others, the skill flags it as a **probable un-marked epic** and recommends adding `kind: epic` + `parent:` rather than silently reclassifying.

## Structural validation

Before grading quality, the skill verifies each issue is structurally valid for its type:

- **Every issue** — `##` H2 title, optional fenced `yaml` block immediately after it, meaningful body.
- **Epic** — `kind: epic` (or `Epic` label / referenced as a `parent`); no `parent` of its own; **no** `### Acceptance Criteria`; a substantive `### Why is this needed?` section.
- **User story** — acceptance criteria in either form: an inline `### Acceptance Criteria` checkbox list, OR one or more `kind: criterion` sub-items that reference it via `parent:` (how a `--sync-criteria` export represents them); optional `parent`.

Structural failures include: an epic with acceptance criteria, a nested epic (an epic with its own `parent`), malformed `yaml`, a user story with **neither** an inline `### Acceptance Criteria` section **nor** any `kind: criterion` children referencing it, and a `parent` that resolves to a non-epic **in the same file**.

**Exported files self-annotate.** A file produced by `export` (now the best-annotated input) stamps `kind`/`parent` and renders both a story's acceptance criteria and an epic's inline ACs as separate `kind: criterion` child issues — so exported **epics are AC-less by construction** (the epic-with-AC rule is satisfied automatically, and the house-convention override below is only needed for hand-authored pre-import files), and exported **stories carry their ACs as criterion children**, which the skill evaluates as that story's acceptance criteria.

Because planestories supports **cross-file nesting**, a `parent:` identifier that is not present in the file is treated as a likely valid reference to an epic in another file — noted in the Hierarchy Review, not failed. When the session has Plane board access (the Plane MCP), the skill can verify that identifier resolves to a real epic and label it "verified"/"unverified".

If a story is malformed or missing acceptance criteria, the skill fails it explicitly rather than pretending it is merely low quality.

**House-convention override.** For greenfield authoring, an epic should have no acceptance criteria (its value goes in a `### Why is this needed?` section). If your project's convention is instead that epics carry acceptance criteria as their close/exit conditions, tell the skill at invocation and it treats epic-with-AC as a **warning** rather than a structural failure — useful for rating an existing board of legacy epics without drowning real findings in structural fails. The `### Why is this needed?` → zero-Rationale → 70% cap still applies, so a rationale-less epic still fails on score.

## Rubrics (type-specific)

Each issue is scored on a 0-100% scale using the rubric for its type.

### User story

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| **Specificity** | 30% | Concrete values, actors, states, and boundaries rather than vague language |
| **Testability** | 35% | Each criterion has a clear pass/fail a QA engineer could turn into a test case |
| **Completeness** | 25% | Happy path, error states, edge cases, and relevant boundaries covered |
| **Description Quality** | 10% | Enough implementation context and constraints for a developer |

### Epic

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| **Goal Clarity** | 30% | A concrete high-level capability/outcome with identifiable beneficiaries |
| **Scope and Decomposition** | 30% | Boundaries, workstreams, exclusions, and structure to judge whether children belong |
| **Rationale** | 30% | A substantive `### Why is this needed?` section (user/business/operational/technical value) |
| **Description Quality** | 10% | Context, constraints, dependencies, and domain language |

A missing or empty `### Why is this needed?` section scores zero for Rationale, which caps the epic at 70% — below the 80% pass threshold. A circular rationale that merely restates the title earns little or no Rationale credit.

These dimensions produce the numeric score, but score alone does not determine pass/fail.

## Hard-fail contradiction detection

Contradiction detection is a hard-fail rule, not a weighted scoring dimension. Any contradiction causes every affected issue to fail, even if the numeric score is 80% or higher.

The skill checks contradictions at two severity levels.

### Hard contradictions

The same entity, workflow, or feature area with mutually exclusive requirements. Checked:

- **Within an issue** — title vs description, title vs acceptance criteria, description vs acceptance criteria, and criterion vs criterion
- **Across user stories** — conflicting behavior, routes, timing, auth methods, permissions, state transitions, retry limits, or validation rules for the same workflow or feature area
- **Epic vs its child stories** — the epic's goal, scope, constraints, or rationale against any story that nests under it via `parent`
- **A user story vs its referenced epic**

Examples:

- Story title says email/password login, but acceptance criteria require SSO-only login
- One criterion redirects to `/dashboard` while another remains on the login page after the same successful action
- Two stories define different expiry times (24 hours vs 15 minutes) for the same reset link
- An epic requires SSO-only authentication while a child story requires email/password login
- An epic's scope excludes password recovery while a story nested under it implements password recovery
- Story A says "users can withdraw tokens at any time" but Story B locks withdrawals during the vesting period for the same token
- Story A calculates staking rewards per block while Story B distributes them on a fixed 24-hour epoch for the same pool

### Tensions

Different domains or features with potentially conflicting assumptions that are not yet mutually exclusive. Flagged as warnings; they do not hard-fail.

Examples:

- One story assumes account data is permanently deleted on closure while a separate audit-trail story assumes transaction history is retained indefinitely
- A gas-optimization story targets minimizing storage writes while a separate event-logging story requires emitting events on every state change

Contradictions matter especially for agentic development: they produce ambiguous implementation targets and unreliable definitions of done.

## Pass/fail rules

An issue passes only if all of the following are true:

- Its **type-specific** numeric score is **80% or above**
- It is structurally valid for its type
- No hard contradiction was found within the issue
- It does not hard-contradict any other issue in the file

If any condition fails, the issue fails. Tensions are reported but do not cause failure.

## Anti-patterns detected

**In user-story acceptance criteria**, the skill flags subjective or unquantified language, each with an explanation and a concrete rewrite:

- **Subjective UI language** — "easy to use", "intuitive", "nice looking", "user-friendly", "clean UI", "visually appealing", "looks good", "modern design"
- **Unquantified performance** — "fast", "responsive", "smooth", "quick" (without thresholds like "< 200ms")
- **Weasel words** — "should work well", "properly handles", "appropriate", "reasonable", "seamless", "robust"
- **Ambiguous scope** — "etc.", "and more", "as needed", "where applicable", "various"

**In epics**, the skill flags: unbounded scope, solution-first wording with no stated outcome, missing workstreams or boundaries, implementation-level acceptance criteria (epics should have none), circular rationale, and placeholder rationale.

### Style guide recommendation

When UI or visual acceptance criteria are unverifiable (e.g., "the button looks professional"), the skill recommends creating a **style guide** with concrete design rules (hex colors, spacing, typography, component specs) that acceptance criteria can reference instead.

**Before:** "Button looks good and matches the design"
**After:** "Button uses the primary action style defined in the style guide (background: `#2563EB`, text: white, padding: `8px 16px`, border-radius: `6px`)"

## Output format

The report is structured as:

1. **Summary table** — Every epic and user story with its **type**, score, pass/fail status, and the primary reason (hard contradiction, structural issue, below-threshold score, or pass)
2. **Hierarchy review** — Each epic and the stories that nest under it; any probable un-marked epic (with the recommended `kind: epic` + `parent:` fix); same-file `parent` references that resolve to a non-epic (failures); `parent` references not present in the file (likely valid cross-file epics — noted, not failed, and "verified"/"unverified" when board access is available); standalone user stories; and scope-fit concerns that are not outright contradictions
3. **Contradictions and tensions** — Every hard contradiction and tension, with severity, affected issues, quoted conflicting statements, and the reasoning. For hard contradictions, the chosen normalization and the discarded interpretation. For tensions, the risk if both ship as-is.
4. **Detailed breakdown with inline replacement markdown** — Every failed issue gets per-dimension scores for its type, flagged content with rewrites, suggested additions, and immediately after, a full replacement markdown block in the canonical `planestories` format — so the reader sees the diagnosis and fix together
5. **Style guide recommendation** — Included only when UI/visual anti-patterns are detected
6. **Passing issues** — Brief listing of the epics and stories that passed, with one-line notes

## Installation

The skill is a project-local Claude Code command, included automatically when you clone the planestories repository — no additional installation is needed. The skill file lives at `.claude/commands/rate-userstories.md`.

### Using in other projects

To add this skill to any project, copy the skill file:

```bash
mkdir -p .claude/commands
cp path/to/planestories/.claude/commands/rate-userstories.md .claude/commands/
```

It works with any markdown file that follows the planestories format (H2 issue headings, `### Acceptance Criteria` sections with checkbox lists, and optional `kind`/`parent` metadata).

## Replacement markdown requirements

Replacement markdown is intended for human review first and source-document updates second.

The skill:

- Emits a complete replacement block, not just rewritten bullet points, in the canonical structure from [USER_STORY_FORMAT.md](./USER_STORY_FORMAT.md)
- **Epic replacements** preserve valid metadata and the epic marker (`kind: epic` / `Epic` label), add **no** acceptance criteria, and include a clear goal, scope, and substantive `### Why is this needed?` section
- **User story replacements** preserve valid metadata and any `parent` reference, and include a concrete description and a `### Acceptance Criteria` checkbox list
- Preserves `plane_id`, `plane_identifier`, `plane_url`, `plane_hash`, `labels`, `parent`, and `kind` unless a hierarchy fix requires changing them — `plane_hash` is tool-managed and never hand-edited
- Rewrites enough of the issue to remove ambiguity and contradictions, not just the single offending line
- Emits consistent replacement blocks for **all** affected issues when a hard contradiction spans multiple issues, all reflecting the same normalization choice — e.g. "Proposed normalization: 24-hour expiry (from Story A). Discarded: 15-minute expiry (from Story B)."
- Places each replacement block inline, immediately after the issue's detailed breakdown

The skill does not assume its rewrite is authoritative product truth. The human reviewer decides whether to accept the proposed markdown and merge it back into the original document; the skill does not modify the source file.
