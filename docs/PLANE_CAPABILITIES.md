# What the Plane API can and cannot do — by deployment

Three separate sessions have independently rediscovered the same three facts, each costing hours.
This page exists so the fourth one does not. Everything here is measured against a live instance,
with the reproduction, not read off documentation.

**Check which deployment you are on before trusting any of this.** Every board-touching command
prints its target first:

```
→ plane.porcupine.works · workspace archimedes · project Data Platform · dialect work-items (detected) · --context ce
```

---

## The three that keep biting

### 1. Relations live under two different endpoint families

CE serves work items under `/work-items/`; Plane Cloud serves `/issues/`. The relation
sub-resource **404s when you ask the wrong family**, and the bare error reads exactly like "this
deployment has no relation API".

```
dialect=work-items   getRelations: OK
dialect=issues       getRelations: 404
```

Same instance, same key. When `dialect` is absent, planestories samples one existing work item and
uses a relation `GET` to select the endpoint family once per context. An explicit context value
(`"dialect": "work-items"` or `PLANE_CTX_<NAME>_DIALECT=work-items`) overrides detection. An
inconclusive probe falls back to `issues` and warns instead of silently treating a failed call as
evidence. Run `planestories capabilities [--context X]` to see the selected dialect and the
deployment's measured capability matrix.

**A 404 here is a routing mistake, not a missing feature.**

### 1b. …but on CE, relation REMOVAL genuinely is missing

Verified on CE 1.4.1, with the dialect set correctly:

| call | CE |
|---|---|
| `POST …/work-items/{id}/relations/` | **201** — create works |
| `GET  …/work-items/{id}/relations/` | **200** — list works |
| `POST …/work-items/{id}/relations/remove/` | **404** |
| `DELETE …/work-items/{id}/relations/{target}/` | **404** |
| `DELETE …/{issues,work-items}/{id}/issue-relation/{target}/` | **404** |

So **`blocked_by` / `blocks` edits are one-way on CE**: planestories can add an edge from a story
file but cannot delete one. Removing a `blocked_by:` line leaves the board unchanged, and the file
and board diverge with no API-level way to reconcile them.

**Remove the link in the Plane UI**, or leave the edge in the file. `import` reports each edge it
could not remove, names this limitation, and withholds `plane_hash` for the affected stories so the
divergence stays visible instead of being hashed away as synced.

### 2. `blocked_by` / `blocks` are RELATIONS. Parent/child is HIERARCHY.

Different mechanisms, different endpoints. A child count comes from each item's `parent` field in
the ordinary work-item list and **never touches the relation API**. Conflating them has produced
two separate false conclusions that the relation API was unavailable.

### 3. Plane Cloud and self-hosted CE are different instances with different boards

After a cutover the old cloud project may still exist, renamed, frozen at the cutover date. An MCP
or CLI pointed at the wrong one returns plausible, *stale* data rather than an error — and
`claude mcp list` reports "✔ Connected" for a config it health-checks in a **fresh** process, not
for the connection your session is actually holding.

---

## Community Edition: no server-side work-item filtering. At all.

Verified on `PLANE_COMMUNITY` v1.4.1 (2026-08-23):

| request | CE result |
|---|---|
| `GET …/work-items/?pql=…` | **HTTP 400** — `{"pql":"PQL and structured filters are not supported on this Plane edition…","unsupported_parameters":["pql"]}` |
| `GET …/work-items/?filters=…` | **HTTP 400** — same rejection |
| `GET …/work-items/?per_page=1` | **HTTP 200**, and carries `total_count` (the true DB total) |
| `count_work_items` (MCP tool) | **HTTP 404** — the endpoint does not exist on CE, with or without a filter |

**This is not a gate you can open.** The rejection in `plane/api/views/issue.py` is unconditional —
it does not branch on edition, licence, or a feature flag — and no PQL engine ships in the
community image. `InstanceEdition.PLANE_COMMUNITY` is hardcoded at registration and inert: flipping
it changes nothing, because the implementing code is absent. The word "edition" in the error is a
pointer to the commercial product, not a live toggle.

**Do not** attempt to patch the check out. There is nothing behind it, and you would be running the
authoritative board on a modified server.

### The version trap

`GET /api/instances/` on CE reports `current_version: 1.4.1 · latest_version: v1.4.1 ·
is_current_version_deprecated: false`. Meanwhile Plane's changelog announces PQL in **v2.6.0**.
Both are true: **2.x is the Commercial Edition line**, distributed via the Prime Portal, a
different image on a different track. A community instance on 1.4.1 is current, not behind.

### What this means in practice

Every filtered question has exactly two shapes on CE:

1. `list_work_items` **without** `pql`, read `total_count`, and filter client-side; or
2. pull the whole board once and query it locally.

planestories does (2) — `atlas --json` emits every item with status, labels, assignee, effort,
criteria, quality and dependency edges, which is a **superset** of what a PQL result would contain
(PQL cannot return effort parsed from a body line, criteria state, or inferred epic structure).

On a VPS you control, raise the API key rate limit and this is cheap. `apiRateLimit` in the context
turns pacing on so planestories stays under it.

---

## Both editions

- **Custom relation *definitions*** are a paid feature (`list_work_item_relation_definitions` → 402
  on cloud, absent on CE). Built-in `blocked_by` / `blocks` / `relates_to` need none of it, and are
  what planestories uses.
- **`list_work_items` defaults to `per_page: 25`.** Without following `next_cursor` until
  `next_page_results` is false you get 25 rows and no error. `total_count` is the true total
  regardless of page size.
- **Pagination is real**: the `DATA` board is 2662 items ≈ 27 pages at 100/page. planestories walks
  all of them in one sweep (`fetchProjectIndex` follows the cursor to exhaustion).

---

## Reproductions

```bash
# which deployment, which edition, which version
curl -s -H "X-API-Key: $KEY" https://<host>/api/instances/ | jq '.instance |
  {current_version, latest_version, edition}'

# is PQL available?
curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: $KEY" \
  "https://<host>/api/v1/workspaces/<slug>/projects/<uuid>/work-items/?pql=stateGroup%20IN%20openStates()"
# 400 => not available (CE).  200 => available (Commercial/Cloud).

# does the relation endpoint answer on this dialect?
curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: $KEY" \
  "https://<host>/api/v1/workspaces/<slug>/projects/<uuid>/work-items/<item-uuid>/relations/"
# 404 => wrong dialect for this deployment, not a missing API.
```
