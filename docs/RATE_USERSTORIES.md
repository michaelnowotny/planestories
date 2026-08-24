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

Every criterion is first classified **gate** or **task** by one question:

> **Describe a build that satisfies every OTHER criterion but fails this one. Is that build WRONG,
> or merely UNFINISHED?**

Wrong → **gate**: it excludes a way the work could be wrong while looking right. Unfinished →
**task**: it describes work, and cannot fail in a way that changes a decision.

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| **Discrimination** | 30% | What fraction of criteria are **gates** (reported as `gates/total`). **Non-monotonic: adding a task LOWERS it.** |
| **Risk Coverage** | 20% | For each way this could be wrong-while-looking-right, is there a gate? Not "did you list all the work" |
| **Testability** | 20% | Each criterion has a clear pass/fail. Necessary, and unable to tell a gate from a task |
| **Specificity** | 20% | Concrete where it changes what gets built; evidence belongs in the body |
| **Description Quality** | 10% | Implementation context and constraints, including the outcome-delta sentence |

A user story must state **what is true after it lands that is not true now**. Missing or circular
caps it at **75%** — below the pass threshold — the same way a missing `### Why is this needed?`
caps an epic at 70%. If that sentence needs an "and", it is two stories.

#### And a second question, after gate-or-task

> **Name one build that would satisfy this.**

A criterion can be a perfect gate and still be **unsatisfiable** — met by no correct implementation,
because the mathematics or the platform forbids it. Such a criterion is not demanding; it is broken,
and a builder will either fail against it forever or quietly launder the impossibility into a pass.
Flagged as a **structural finding**, not a score deduction. Specimen S7 in the calibration corpus.

#### Why this changed (2026-08-23)

The previous rubric was **Specificity 30 / Testability 35 / Completeness 25 / Description 10**, and
every one of those dimensions was **monotonic in writing effort**: adding a criterion, a concrete
value, or a paragraph could only ever raise the score. A rubric with that property cannot
distinguish *writing the right things* from *writing more things*, so length was free and dilution
was invisible.

The case that surfaced it (relayed from a sibling session, 2026-08-23): a spec with **twenty**
acceptance criteria produced a build with two defects, and **neither defect was in any of the
twenty**. One criterion enumerated five required diagnostic columns by name — and the field a human
would ask for first, *why* the estimator failed, was not among them. Under the old rubric that
ticket scored close to exemplary: twenty clean pass/fail lines, concrete values throughout, maximum
Completeness. Roughly four of the twenty were gates, and the reviewer's attention was spread over
all twenty.

Three deliberate choices in the fix:

- **Discrimination penalises the RATIO, not the count.** Penalising the count would push an author
  to delete criteria — including gates — to score better. Penalising the ratio means the only way up
  is to delete **tasks**. A story with ten criteria of which nine are gates is not badly written; it
  is too big, and gets a **split recommendation with no score penalty**.
- **"Completeness" was renamed "Risk Coverage",** because the name was driving the behaviour. The
  old name asks *have I listed everything?*; the new one asks *what could go wrong?* — and only the
  second has an answer that can be missing.
- **The classification is shown, not hidden.** Judging gate-vs-task needs domain understanding and
  will sometimes be wrong. A visible wrong classification is correctable; a hidden one silently
  moves the score.

This is the same rule as the assertion rule in `AGENTS.md` — *an assertion that would still pass
with the feature deleted is not a test* — applied to the specification instead of the check. Both
are instances of: **the value of any check is exactly the set of worlds it excludes.**

Calibration specimens, with expected verdicts, are in
[RATE_USERSTORIES_CALIBRATION.md](./RATE_USERSTORIES_CALIBRATION.md) — including the guard against
the perverse incentive above. The outcome-based study that would actually settle this, and the one
cheap thing needed to make it runnable, are described there too.

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

Three more that are written in *precise, confident, quantified* prose, which is exactly why a rubric
rewarding precision alone rates them highly:

- **Closed enumeration as coverage** — "the diagnostic row contains columns A, B, C, D, E". Passes
  the moment those five exist, and encodes no way to discover a sixth was needed. Rewrite
  generatively: "for every way the estimator can fail, the diagnostic row identifies which failure
  occurred."
- **Measurement smuggling** — a measured value moved into a checkbox because concrete numbers score
  well there. "Baseline p95 is 812ms as measured on 2026-08-19" is true, precise, and cannot fail:
  it is a fact about the past, not a condition on the build. It belongs in the body; the criterion is
  the line it argues for.
- **Restated title** — a criterion that says the story's title back, which cannot fail unless the
  story was not done at all.

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
