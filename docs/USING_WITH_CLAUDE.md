# Using planestories from a Claude Code session

A reusable handoff brief. Give this file (or its contents) to any Claude Code session, in
any project, that should use **planestories** to turn markdown user stories into Plane
work items. Nothing here is specific to a particular repository.

---

## What planestories is

`planestories` is a CLI that syncs markdown user stories — with explicit, testable
acceptance criteria — into work items in [Plane](https://plane.so). Write your plan as
structured stories with `- [ ]` acceptance criteria, push them to Plane as tracked work
items, and use those criteria as your own definition-of-done while you build. It's a fork
of the MIT-licensed `linearstories`, ported to Plane.

## Where it is

- Repo: the planestories checkout (on this machine: `~/PycharmProjects/planestories`).
- Bun/TypeScript project, independent of whatever project you're working in.
- Worth skimming: `README.md`, `docs/USER_STORY_FORMAT.md`, `templates/user-story.md`.

## Setup

- Bun is required (installed at `~/.bun/bin`). In a fresh shell:
  `export PATH="$HOME/.bun/bin:$PATH"`.
- Install deps if `node_modules` is missing: run `bun install` in the repo.
- Credentials live in `planestories/.env` (`PLANE_API_KEY` + `PLANE_WORKSPACE_SLUG`). The
  CLI auto-loads `.env` from its own directory, so **run commands from inside the
  planestories repo**.
- 🔒 **Never print, echo, commit, or paste the API key.** Credentials belong only in the
  gitignored `.env`. If `.env` is missing, ask the operator to create it from
  `.env.example` — do not invent or request the key in plaintext in the conversation.

## Story format

```markdown
---
project: "My Project"          # the Plane PROJECT name (Plane has no "team" tier)
---

## As a <role>, I want <goal>, so that <benefit>

```yaml
plane_id:                      # leave the three plane_* fields empty for new stories
plane_identifier:
plane_url:
priority: high                 # urgent | high | medium | low | none
labels: [Feature]              # skipped with a warning if absent (see --create-labels)
estimate: 3
assignee: someone@example.com  # resolved by email to a project member
status: Backlog                # must match a state name in the project
```

<description in markdown — rendered to HTML in Plane>

### Acceptance Criteria
- [ ] concrete, testable criterion
- [ ] another one
```

A single file can hold many stories (each `## ` heading is one). Frontmatter sets the
default project; per-story overrides are not needed for the project in v1. Start from
`templates/user-story.md`.

## Commands

Run all of these from inside the planestories repo:

```bash
export PATH="$HOME/.bun/bin:$PATH"

# Validate parsing only — no API calls:
bun run src/cli/index.ts import /path/to/stories.md --dry-run

# Create/update work items and write plane_id/plane_identifier/plane_url back into the file:
bun run src/cli/index.ts import /path/to/stories.md

#   --create-labels   create labels that don't exist instead of skipping them
#   --project "Name"  override the project for all stories
#   --no-write-back   don't modify the markdown file

# Export work items from a project back to markdown:
bun run src/cli/index.ts export --project "My Project" -o exported.md
```

The stories markdown file can live anywhere — pass any path.

## Choosing a Plane project

Confirm the target project with the operator. For a low-risk first run, use a sandbox
project (e.g. the Plane demo project) and delete the test work items afterward. To track
real work, pick or create the appropriate project.

## Idempotency & write-back

- After a successful create, `plane_id` (UUID), `plane_identifier` (e.g. `PROJ-12`), and
  `plane_url` are written back into each story's YAML block.
- Re-running an import is **idempotent**: a story with a `plane_id` updates by UUID; a
  story without one is matched by `external_id` (derived from the title) and updated —
  never duplicated.

## Caveats

- Priorities are strings (`urgent`/`high`/`medium`/`low`/`none`); legacy Linear integers
  `0–4` are still accepted.
- Missing labels are skipped with a warning unless you pass `--create-labels`.
- `status` must match an existing **state name** in the project (e.g. `Backlog`, `Todo`,
  `In Progress`, `Done`); unknown states are ignored.
- `assignee` resolves by email (or display name) to a **project member**.
- Export writes the work item's plain-text description; rich formatting is not
  round-tripped.
- Targets Plane Cloud by default; `PLANE_BASE_URL` / `baseUrl` can point at a self-hosted
  instance.

## Optional: you're doing a shakedown / test run

If the operator asked you to evaluate planestories (not just use it), use it for real,
then write concrete feedback — anything broken, confusing, or surprising (error messages,
the markdown format, resolver behavior, idempotency, write-back, export quality, docs
gaps, ergonomics), plus what you'd change if it were your tool. Save the feedback to a
file in the project you're working in (e.g. `external_info/planestories-feedback.md`) and
tell the operator it's ready so they can forward it to the planestories maintainer.
