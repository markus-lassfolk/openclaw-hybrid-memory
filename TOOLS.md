# TOOLS.md — Delegation Rules and Tool Reference

This document defines how the main agent (Maeve) delegates to subagents and
what tools are available for structured coordination.

---

## Subagent Delegation Rules

### When to Delegate

| Condition | Delegate to |
|-----------|-------------|
| Code changes requiring PR creation | Forge |
| Deep research / issue analysis | Scholar |
| Architecture review / blueprint | Ralph |
| Any task > 30 min estimated work | Forge (with ACTIVE-TASK.md entry) |

### Delegation Checklist

Before dispatching a subagent:

1. Create an `ACTIVE-TASK.md` entry with `Status: In progress`
2. Include a clear `goal:` (one sentence)
3. Specify the target branch
4. Include the **Required Output Format** section from `AGENTS.md`

### Receiving a Handoff

When a subagent returns a structured handoff block:

1. Parse using `parseHandoffFromText()` from `extensions/memory-hybrid/services/handoff.ts`
2. Validate using `validateHandoff()`
3. Update `ACTIVE-TASK.md` with `formatHandoffSummary()` result
4. Mark task `Done` if `status: completed`
5. Log artifacts to memory if relevant

### Handling Non-Structured Returns

If a subagent returns prose without a structured handoff:

1. **Do not accept** — ask the subagent to re-run with the handoff template
2. If re-run is not possible, manually construct a partial handoff block and
   note `status: partial` with appropriate `risks[]`

---

## Handoff Tooling

The handoff schema is implemented in:

- **Types:** `extensions/memory-hybrid/types/handoff-types.ts`
- **Service:** `extensions/memory-hybrid/services/handoff.ts`
- **Tests:** `extensions/memory-hybrid/tests/handoff.test.ts`

### Key functions

```typescript
import {
  createHandoff,       // Create a new HandoffBlock
  serializeHandoff,    // Serialize to YAML fence string
  parseHandoffFromText, // Parse from agent prose output
  validateHandoff,     // Validate a HandoffBlock object
  formatHandoffSummary, // One-line summary for ACTIVE-TASK.md
} from "extensions/memory-hybrid/services/handoff.js";
```

---

## ACTIVE-TASK.md Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `Branch` | Yes (if applicable) | Git branch for the task |
| `Status` | Yes | One of: In progress, Waiting, Stalled, Failed, Done |
| `Subagent` | When delegated | Subagent session key |
| `Handoff` | After first checkpoint | `formatHandoffSummary()` output |
| `Next` | Yes | What to do next / what's blocking |
| `Started` | Yes | ISO-8601 timestamp |
| `Updated` | Yes | ISO-8601 timestamp (update on every change) |
