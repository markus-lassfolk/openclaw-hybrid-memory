# Release notes — OpenClaw Hybrid Memory **2026.5.280**

This release consolidates the May 28 reliability push for the hybrid-memory plugin. It focuses on making maintenance automation honest, safer, and easier to operate: skipped work is reported as skipped, degraded extraction no longer pretends to be success, and untrusted chat/metadata is handled more defensively.

## Highlights for operators

### Maintenance semantics are more trustworthy
- Added broader maintenance task semantics coverage so wrapper-style jobs prove their intended work completed, skipped for a known reason, or failed loudly.
- Improved cron/wrapper ledger semantics around skipped, analyzed, failed, and partial outcomes.
- Added progress heartbeat logging for quiet maintenance phases, making long-running jobs easier to distinguish from stalled jobs.

### Self-correction handles messy model output better
- Hardened self-correction JSON parsing for fenced, prose-wrapped, and otherwise non-strict LLM responses.
- Cooldown skips are now surfaced as skips instead of successful maintenance.
- Parse/fallback paths now provide clearer operator evidence when analysis output cannot be trusted.

### Extraction paths fail more honestly
- `extract-reinforcement` no longer reports success after finding incidents but producing zero annotations without fallback.
- `extract-directives` is hardened against durable storage of untrusted metadata/chat fragments.

### Safer multi-agent memory behaviour
- Persona proposal generation is scoped to avoid cross-agent/user contamination.
- Legacy forge/episode category remap policy is now documented for more predictable normalization.

## Included issue/PR work

- #1637 / #1643 — self-correction non-strict JSON handling and cooldown-skip semantics.
- #1638 / #1644 — comprehensive tests for maintenance task semantics.
- #1639 / #1642 — extract-reinforcement degraded-success reporting.
- #1640 / #1650 — extract-directives untrusted metadata hardening.
- #1645 / #1651 — category remap policy for legacy forge/episode categories.
- #1646 / #1649 — persona proposal scope isolation.
- #1647 / #1648 — progress heartbeat logging for silent maintenance phases.

## Upgrade notes

Update the plugin and installer packages to **2026.5.280** together so manifests, installer metadata, and package locks remain aligned.

```bash
npm install -g openclaw-hybrid-memory@2026.5.280
```

If you use `openclaw-hybrid-memory-install`, align it to the same version.
