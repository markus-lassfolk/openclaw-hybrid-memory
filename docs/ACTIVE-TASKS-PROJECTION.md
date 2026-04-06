# ACTIVE-TASKS.md projection (facts ledger)

When `activeTask.ledger` is `facts`, the canonical task state lives in hybrid-memory **`category:project`** facts (same store as `memory_store`). **`ACTIVE-TASKS.md`** is an optional **read-only projection** for humans and agents.

## Regenerate

```bash
openclaw hybrid-mem active-tasks render
```

Requires `activeTask.ledger: facts`. With the default `markdown` ledger, the file **is** the ledger—no render step.

## Timestamp semantics

The projection must not invent “when work started” or “last touch” from the render clock.

- **Started** uses fact fields in order: `started`, `task_started`, `created_at` (parseable), then the **earliest** SQLite `createdAt` among fact rows for that task entity.
- **Updated** uses: `task_updated`, `updated`, `updated_at`, then the **latest** `createdAt` in the row.
- If nothing can be resolved, the markdown shows **Unknown**. Those rows are treated as **stale** for `activeTask.staleThreshold` (no trustworthy “last update” time).

## Sections and filters (`activeTask.projection`)

| Key | Meaning |
|-----|---------|
| `mode` | `readable` (default): drop generic titles, optional dedupe. `full`: skip those filters; list everything (caps still apply if set). |
| `excludeGenericTitle` | Default `true`: omit rows whose title is only the placeholder “Project task”. |
| `titleMinChars` | If &gt; 0, drop shorter titles (readable mode). |
| `dedupeBy` | `none` (default), `label`, or `normalizedTitle`. |
| `maxRowsPerSection` | Cap **Active**, **Stale — revisit**, and **Completed** separately; a short footer line counts omitted rows. |
| `sectioned` | Default `true`: **Active** (not stale), **Stale — revisit**, **Completed**. Set `false` for the legacy flat `## Active Tasks` layout. |

Empty sections are **omitted** (no blank headings), except the all-empty case which shows a single **Active** block with *No active tasks.*

## Operator playbook

1. **Close or update work** via `memory_store` / facts (set status to `done`, `failed`, etc., or update `task_updated` and narrative keys).
2. Run **`hybrid-mem active-tasks reconcile`** when subagent **Session:** references point at missing transcripts—rows can be completed automatically.
3. Run **`hybrid-mem active-tasks render`** to refresh the markdown.

See also [TASK-HYGIENE.md](TASK-HYGIENE.md) for heartbeat nudges and `active_task_propose_goal`.

## Optional goal links

Project facts may include **`related_goal`** or **`goal_id`** on a task entity; the projection adds a **Related goal** line when present.
