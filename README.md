# planestories

A CLI tool that bridges markdown-based user stories and [Plane](https://plane.so) work items, enforcing user story and acceptance-criteria discipline for AI agent-driven development.

> **Attribution.** planestories is a fork of [**linearstories**](https://github.com/stackingturtles/linearstories) by **Ijonas Kisselbach / Stacking Turtles Ltd.**, adapted to target Plane instead of Linear. The original is MIT-licensed; that license is preserved in full (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE)). Huge thanks to the original author.

## Why structured acceptance criteria matter for AI agents

AI coding agents — Claude Code, Cursor, Copilot Workspace, and others — perform dramatically better when given precise, testable acceptance criteria. Vague tickets like "improve the login flow" lead to ambiguous implementations and wasted iteration cycles. Structured user stories with explicit acceptance criteria give agents the deterministic guardrails they need:

- **Clear scope boundaries.** Each acceptance criterion is a discrete, verifiable condition.
- **Testable by default.** Criteria written as checkboxes (`- [ ] ...`) map directly to test cases.
- **Markdown as the source of truth.** Stories live in your repository alongside the code.
- **Two-way sync with Plane.** Managers keep their board current; agents keep their specs current.

## Quick start

### 1. Install

Run directly with `bunx` (no install required):

```bash
bunx planestories import stories/*.md
```

Or install globally / build a binary:

```bash
bun install -g planestories
# or build from source:
bun install
bun build src/cli/index.ts --compile --outfile planestories
```

### 2. Provide credentials (never commit them)

Credentials live in a **gitignored `.env`** file — never in a committed config. Copy `.env.example` to `.env` and fill in:

```bash
PLANE_API_KEY=plane_api_xxxxxxxxxxxxxxxxxxxx      # Plane > Profile Settings > Personal Access Tokens
PLANE_WORKSPACE_SLUG=your-workspace-slug          # the app.plane.so/<slug>/... part of your URL
# PLANE_BASE_URL=https://api.plane.so             # only override when self-hosting
```

### 3. Add non-secret defaults (optional)

Create `.planestoriesrc.json` in your project root for **non-secret** defaults. **Do not put `apiKey` here** — it comes from `.env`.

```json
{
  "workspaceSlug": "your-workspace-slug",
  "baseUrl": "https://api.plane.so",
  "defaultProject": "Q1 2026 Release",
  "defaultLabels": ["User Story"]
}
```

`PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, and `PLANE_BASE_URL` from the environment always override config-file values.

### 4. Write your first story

Create `stories/login.md` (see [`templates/user-story.md`](./templates/user-story.md)):

````markdown
---
project: "Q1 2026 Release"
---

## As a user, I want to log in so that I can access my account

```yaml
plane_id:
plane_identifier:
plane_url:
priority: high
labels: [Feature, Auth]
estimate: 3
assignee: jane@company.com
status: Backlog
```

User should be able to log in with their email and password.

### Acceptance Criteria

- [ ] User can enter email and password on the login page
- [ ] Invalid credentials show a clear error message
````

### 5. Import

```bash
planestories import stories/*.md            # create/update work items, write ids back
planestories import stories/*.md --dry-run  # parse + validate only, no API calls
```

After a successful import, `plane_id` (the work item UUID), `plane_identifier` (e.g. `ENG-42`), and `plane_url` are written back into each story's YAML block.

## How fields map to Plane

| Story field | Plane |
|---|---|
| `project` (frontmatter or `--project`) | the work item's **project** (required — Plane has no "team" tier) |
| `## Heading` | work item name |
| body markdown | `description_html` (converted to HTML) |
| `priority` | `urgent` / `high` / `medium` / `low` / `none` (legacy Linear integers `0–4` are also accepted) |
| `status` | work item **state** (resolved by name within the project) |
| `labels` | label UUIDs (resolved by name within the project) |
| `assignee` | member UUID (resolved by email or display name) |
| `estimate` | story `point` |
| `plane_id` | work item UUID (used to update) |

### Idempotency

On create, planestories stamps each work item with `external_id` (derived from the story title) and `external_source: "planestories"`. Re-running an import — even before write-back — matches the existing work item by `external_id` and **updates instead of duplicating**.

### Missing labels

By default, labels that don't exist in the project are **skipped with a warning** (deduped, one line per label). Pass `--create-labels` to create them instead.

### Acceptance criteria as sub-items (`--sync-criteria`)

By default a story's `### Acceptance Criteria` checklist is stored in the work item's description. Pass `--sync-criteria` to instead sync **each criterion to a Plane sub-item** (a child work item). A `- [x]` maps to a completed-group state and `- [ ]` to an open state, so ticking a box in markdown moves the sub-item — and `export --sync-criteria` reconstructs the checklist from the sub-items' states. The mapping is idempotent (keyed per criterion), so re-imports update in place.

## Commands

### `import`

```
planestories import <files...> [options]
  -c, --config <path>     Config file path
  --context <name>        Select a named context from a multi-context config
  -p, --project <name>    Override the default project
  --create-labels         Create labels that don't exist instead of skipping
  --sync-criteria         Sync each acceptance criterion to a Plane sub-item
  --dry-run               Preview without writing to Plane
  --check                 With --dry-run, validate read-only (project/state/assignee/labels)
  --no-write-back         Skip writing Plane ids back into the markdown
```

### `export`

```
planestories export [options]
  -o, --output <file>       Output file (default ./exported-stories.md)
  -p, --project <name>      Project to export from (required if no defaultProject)
  -i, --issues <ids>        Comma-separated work item identifiers (e.g. ENG-8)
  -s, --status <state>      Filter by status
  -a, --assignee <email>    Filter by assignee email
  -l, --label <name>        Filter by label name
  --external-source [src]   Only export items planestories created (default: planestories)
  --sync-criteria           Reconstruct acceptance criteria from sub-items
```

Export converts Plane's HTML description back to markdown (headings and `- [ ]`/`- [x]` checklists survive a round-trip), and emits stories in ascending identifier order.

### `set`

Update fields on existing work items by identifier — handy for moving a card without editing YAML.

```
planestories set <identifiers...> [options]   # e.g. set ENG-12 ENG-13 --status "In Progress"
  -p, --project <name>    Project (required if no defaultProject)
  -s, --status <state>    Set the state by name
  --priority <level>      urgent | high | medium | low | none
  -a, --assignee <email>  Set the assignee by email
```

### `delete`

Delete (or archive) work items — **scoped only**, never a blunt project wipe. Either by the files' `plane_id`s (which clears `plane_*` back out as the inverse of import) or by `external_source` within a project.

```
planestories delete <files...> [options]
planestories delete --external-source [src] --project <name> [options]
  --archive               Archive instead of hard delete (only completed/cancelled items)
  --dry-run               Show what would be deleted, change nothing
  -y, --yes               Confirm deletion (required — without it, only the plan is shown)
  --no-write-back         Don't clear plane_* out of files after deletion
```

## Self-hosting

planestories works against Plane Cloud by default (`https://api.plane.so`). To target a self-hosted instance, set `PLANE_BASE_URL` (env) or `baseUrl` (config) to your instance URL — no code changes required.

## Multiple workspaces (contexts)

A config file may define named contexts; select one with `--context <name>`:

```json
{
  "contexts": [
    { "name": "orgA", "workspaceSlug": "org-a", "defaultProject": "Q1 Release" },
    { "name": "orgB", "workspaceSlug": "org-b", "defaultProject": "Brand Refresh" }
  ]
}
```

## Development

```bash
bun install
bun test            # run the test suite
bun run lint        # biome
```

## License

MIT. See [`LICENSE`](./LICENSE) (original © Stacking Turtles Ltd.) and [`NOTICE`](./NOTICE) for attribution and modification copyright.
