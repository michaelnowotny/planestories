# User Story Markdown Format

Reference for the markdown format consumed by the `planestories` CLI.

## File structure

```
---                          ← optional YAML frontmatter
project: "Project Name"
---

## Story title               ← H2 = one story (multiple per file OK)

```yaml                      ← optional metadata block
plane_id:
plane_identifier:
plane_url:
priority: high
labels: [Feature, Auth]
estimate: 3
assignee: jane@company.com
status: Backlog
```

Description text.            ← body (markdown), becomes the work item description

### Acceptance Criteria      ← H3 heading, part of body

- [ ] First criterion
- [ ] Second criterion
```

## Frontmatter

Optional. Sets defaults for all stories in the file.

| Field     | Type   | Description          |
|-----------|--------|----------------------|
| `project` | string | Default project for every story in the file (Plane has no "team" tier — the project is the routing key). A per-story `project:` or the `--project` flag overrides it. |

## Story heading

Each story starts with `## `. The heading text becomes the Plane work item name.

Recommended format: `As a [role], I want [goal] so that [benefit]`

## Metadata block

Fenced YAML block (` ```yaml ` ... ` ``` `) immediately after the H2 heading. All fields optional.

| Field              | Type     | Values / Notes                                                        |
|--------------------|----------|-----------------------------------------------------------------------|
| `project`          | string   | Project for this story; overrides the file frontmatter. `--project` overrides both. |
| `plane_id`         | string   | Work item UUID. Auto-filled on import; used to update. Leave empty for new stories. |
| `plane_identifier` | string   | Human-readable id (e.g. `ENG-42`). Auto-filled on import.             |
| `plane_url`        | string   | Work item URL. Auto-filled on import.                                 |
| `priority`         | string   | `urgent`, `high`, `medium`, `low`, `none` (legacy Linear integers `0–4` are also accepted) |
| `labels`           | string[] | Label names (resolved within the project). Merged with `defaultLabels` from config. Missing labels are skipped unless `--create-labels`. |
| `estimate`         | number   | Story points.                                                         |
| `assignee`         | string   | Email or display name (resolved to a project member).                 |
| `status`           | string   | State name: `Backlog`, `Todo`, `In Progress`, `Done`, etc. (resolved within the project) |

## Body

Everything after the metadata block until the next `## ` or end-of-file. Standard markdown. Converted to HTML and stored as the work item's description.

## Acceptance criteria

Convention: use an `### Acceptance Criteria` heading with a checkbox list. This section is part of the body and is included in the work item description.

```markdown
### Acceptance Criteria

- [ ] Criterion one
- [ ] Criterion two
```

## Minimal example

```markdown
## Add logout button

Description of the feature.

### Acceptance Criteria

- [ ] Logout button visible on all authenticated pages
- [ ] Clicking logout clears the session and redirects to login
```

## Full example

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
- [ ] User is redirected to the dashboard on successful login

## As a user, I want to reset my password so that I can regain access

```yaml
plane_id:
plane_identifier:
plane_url:
priority: medium
labels: [Feature, Auth]
estimate: 2
```

User should be able to reset their password via email link.

### Acceptance Criteria

- [ ] User can request a password reset from the login page
- [ ] Reset email is sent within 60 seconds
- [ ] Reset link expires after 24 hours
````

## Import behavior

| `plane_id` state | Action                                                              |
|------------------|---------------------------------------------------------------------|
| Empty or missing | Looks up an existing work item by `external_id`; updates it if found, otherwise creates a new one |
| Present          | Updates the existing work item by UUID                              |

After import, `plane_id`, `plane_identifier`, and `plane_url` are written back into the file. On create, planestories also stamps the work item with `external_id` (derived from the title) and `external_source: "planestories"` so re-imports are idempotent.
