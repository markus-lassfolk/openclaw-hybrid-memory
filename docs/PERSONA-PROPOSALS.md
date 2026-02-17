---
layout: default
title: Persona Proposals
parent: Features
nav_order: 12
---
# Persona Proposals

**Agent self-evolution with human approval** — the agent can propose changes to identity files (SOUL.md, IDENTITY.md, USER.md) based on observed patterns; a human reviews and approves or rejects via CLI. No identity file is ever modified by the agent automatically.

---

## Overview

When persona proposals are enabled, the agent gets two tools:

- **`persona_propose`** — Submit a proposed change to an identity file (title, observation, suggested text, confidence, evidence sessions).
- **`persona_proposals_list`** — List proposals filtered by status or target file.

Proposals are stored in a separate SQLite database (`proposals.db` next to `facts.db`). Only **human-only CLI commands** can approve, reject, or apply proposals:

- `openclaw proposals review <id> <approve|reject>`
- `openclaw proposals apply <id>` — Writes the suggested change into the target file (only for proposals that are already **approved**).

Safety is enforced by: allowed-file allowlist, rate limit (e.g. 5/week), minimum confidence and evidence, optional expiry, and a full audit trail.

---

## Enabling

Add to the plugin config in `openclaw.json`:

```json
{
  "personaProposals": {
    "enabled": true
  }
}
```

All other options are optional and have defaults (see [Configuration](#configuration) below).

---

## Agent tools

### persona_propose

Proposes a change to one of the allowed identity files.

| Parameter | Type | Description |
|-----------|------|-------------|
| `targetFile` | enum | One of `SOUL.md`, `IDENTITY.md`, `USER.md` (or subset if you restrict `allowedFiles`). |
| `title` | string | Short title (e.g. "Add tone-matching guidance"). |
| `observation` | string | What the agent observed that motivates the change. |
| `suggestedChange` | string | The exact text to add/change in the file. |
| `confidence` | number | 0–1; must be ≥ `minConfidence` (default 0.7). |
| `evidenceSessions` | string[] | Session IDs or references supporting the proposal; length must be ≥ `minSessionEvidence` (default 10). |

**Checks before creating:**

- Rate limit: proposals created in the last 7 days must be &lt; `maxProposalsPerWeek` (default 5).
- Confidence ≥ `minConfidence`.
- `evidenceSessions.length` ≥ `minSessionEvidence`.

On success, the proposal is stored with status `pending` and an expiry (if `proposalTTLDays` &gt; 0). The agent is told the proposal ID and that it awaits human review.

### persona_proposals_list

Lists proposals with optional filters:

- `status` — `pending` | `approved` | `rejected` | `applied`
- `targetFile` — filter by file

Returns id, status, title, target file, confidence, evidence count, created/expires. No file contents; use review/apply on the CLI to see or apply the change.

---

## Human-only CLI

These commands are **not** exposed as agent tools. Only a human (or a process you control) should run them.

### Review (approve or reject)

```bash
openclaw proposals review <proposalId> approve
openclaw proposals review <proposalId> reject
```

Optional: `--reviewed-by "name"` to record who reviewed.

- Only proposals with status `pending` can be reviewed.
- After **approve**, the proposal status becomes `approved`; you can then run `openclaw proposals apply <proposalId>`.
- After **reject**, the proposal is closed; it cannot be applied.

### Apply (write to file)

```bash
openclaw proposals apply <proposalId>
```

- Only proposals with status **approved** can be applied.
- The target file must still be in `allowedFiles`.
- Path traversal is blocked (no `..`, `/`, `\` in `targetFile`).
- The plugin resolves the path via `api.resolvePath(proposal.targetFile)` and appends the suggested change in a comment block plus the new content. Then the proposal is marked `applied`.

If the target file is missing or write fails, an error is printed and the proposal remains `approved` so you can fix the path and try again.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Turn persona proposals on. |
| `allowedFiles` | `["SOUL.md", "IDENTITY.md", "USER.md"]` | Only these identity files can be modified by proposals. |
| `maxProposalsPerWeek` | `5` | Rate limit: max new proposals in a rolling 7-day window. |
| `minConfidence` | `0.7` | Minimum confidence (0–1) for the agent to submit a proposal. |
| `proposalTTLDays` | `30` | Days until a **pending** proposal expires; expired ones are pruned. Use `0` for no expiry. |
| `minSessionEvidence` | `10` | Minimum number of session references required in `evidenceSessions`. |

See [CONFIGURATION.md](CONFIGURATION.md) for where to put these in `openclaw.json`.

---

## Safety and behaviour

- **No auto-apply.** Identity files are only changed when a human runs `openclaw proposals apply`.
- **Allowlist.** Only filenames in `allowedFiles` are accepted; path traversal in `targetFile` is rejected.
- **Rate limit.** `persona_propose` fails when the 7-day proposal count would exceed `maxProposalsPerWeek`.
- **Evidence and confidence.** Proposals below `minConfidence` or with fewer than `minSessionEvidence` references are rejected.
- **Expiry.** Pending proposals older than `proposalTTLDays` are removed by a periodic prune (every 60 minutes when the gateway is running). They cannot be reviewed or applied after expiry.
- **Audit.** Each create/review/apply is logged to an audit file under the memory directory (e.g. `proposal-<id>.jsonl`) for traceability.

---

## Background job

When persona proposals are enabled, a timer runs every **60 minutes** and deletes pending proposals whose `expires_at` is in the past. Log message: `memory-hybrid: pruned N expired proposal(s)`.

---

## Related docs

- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [ARCHITECTURE.md](ARCHITECTURE.md) — Role of SOUL.md, IDENTITY.md, USER.md
- [FEATURES.md](FEATURES.md) — Other plugin features
