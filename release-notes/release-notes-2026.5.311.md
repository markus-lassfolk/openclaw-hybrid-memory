# Release notes — OpenClaw Hybrid Memory **2026.5.311**

**Release date:** 2026-05-31  
**Since:** [2026.5.310](release-notes-2026.5.310.md)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.5.311]**

## Hotfix: gateway plugin registration

**2026.5.310** could fail immediately on gateway startup with:

```text
Error: plugin register must be synchronous
```

OpenClaw requires the plugin `register()` hook to return `void`, not a `Promise`. A hot-reload race fix in **2026.5.310** accidentally made registration async.

**2026.5.311** restores synchronous registration while keeping the hot-reload teardown guard: when replacing an existing plugin instance, register still waits for the prior generation’s databases to close before opening new handles (using an event-loop–friendly synchronous wait).

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.5.311
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.5.311** if you use the installer package.
