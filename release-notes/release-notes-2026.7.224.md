# Release v2026.7.224

## Legacy Autonomous Dreaming configuration compatibility

This release preserves valid legacy Autonomous Dreaming settings during upgrades so existing installations continue to boot and retain their intended behavior.

### Fixed

- The plugin manifest accepts legacy `dreaming.frequency`, `model`, `execution`, `phases`, and `verboseLogging` fields instead of rejecting older configurations at gateway startup.
- Upgrade parsing maps supported legacy cron, model, and phase values losslessly to the current configuration shape.
- Unsupported legacy values fail with actionable migration diagnostics rather than being silently discarded.
- Fixture-backed schema and parser regression coverage protects the migration path.

### Versioning

- `openclaw-hybrid-memory`: `2026.7.224`
- `openclaw-hybrid-memory-install`: `2026.7.224`
- `extensions/memory-hybrid/openclaw.plugin.json` is synchronized to the same version by the repository's version-sync script.

### Scope

This release contains the legacy Dreaming configuration compatibility fix from PR #2202 only.
