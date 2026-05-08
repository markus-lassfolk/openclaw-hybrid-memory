# Pending review digest

`openclaw hybrid-mem digest pending` surfaces review backlogs that otherwise rot quietly:

- persona proposals
- validated-but-unpromoted procedures
- self-extension tool proposals
- crystallization proposals
- verified facts awaiting operator attention

## CLI

```bash
openclaw hybrid-mem digest pending --since 7d --format md --out -
openclaw hybrid-mem digest pending --since 7d --format json --out /tmp/pending-digest.json
```

JSON output is versioned with `schemaVersion: 1` and includes the stable summary field:

```text
pendingReview: { persona, procedures, tools, crystallization, verified }
```

## Operator actions

### Persona proposals

- Approve: `openclaw hybrid-mem proposals approve <id>`
- Decline: `openclaw hybrid-mem proposals reject <id>`
- Defer: leave pending, or list later with `openclaw hybrid-mem proposals list --status pending`

### Procedure promotions

- Review: `openclaw hybrid-mem procedures triage --not-promoted`
- Promote where appropriate: `openclaw hybrid-mem generate-auto-skills`
- Defer: leave validated procedures unpromoted

### Tool proposals

- Review: `memory_tool_proposals`
- Approve: `memory_tool_approve id=<id>`
- Decline: `memory_tool_reject id=<id>`
- Defer: leave as `proposed`

### Crystallization proposals

- Review: `memory_crystallize_list`
- Approve: `memory_crystallize_approve id=<id>`
- Decline: `memory_crystallize_reject id=<id>`
- Defer: leave as `pending`

### Verified facts

- Review: `openclaw hybrid-mem verified list`
- Defer: leave verified facts unchanged

## Weekly job

`hybrid-mem install` / `upgrade` ensures the weekly cron job:

```text
hybrid-mem:weekly-pending-digest
```

It runs Mondays at 08:00 with:

```bash
openclaw hybrid-mem digest pending --since 7d --format md
```

Unlike internal maintenance jobs, this job uses announce delivery so the rendered digest is visible to the operator.
