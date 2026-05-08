# OpenClaw loader coordination (issue #1111)

This document tracks **cross-repo** behavior between `openclaw-hybrid-memory` and **OpenClaw core** for when the memory plugin loads and how heavy work runs.

## What this plugin implements

- **`registrationMode === "cli-metadata"`** — [`runMemoryHybridRegister`](../extensions/memory-hybrid/index.ts) exits early after registering CLI metadata for the `hybrid-mem` root command (no database or LanceDB initialization). OpenClaw uses this path in [`loadOpenClawPluginCliRegistry`](https://github.com/openclaw/openclaw) (bundled as `loadOpenClawPluginCliRegistry` in the `openclaw` package).
- **Full registration** — unchanged for gateway, agents, and `openclaw hybrid-mem …` when the host performs a full plugin load with `registrationMode === "full"`.
- **Deferred work** — non-critical startup checks (e.g. Python document-bridge dependency probing) may run from the plugin service `start()` hook instead of synchronously during `register()`, where safe.

## What belongs in OpenClaw core (upstream)

These items require changes or policy in the **`openclaw`** repository, not only in this plugin:

1. **Empty `onlyPluginIds` scope** — When `ensurePluginRegistryLoaded({ scope: "channels" })` resolves to an **empty** channel plugin list, the loader should not treat that as “no filter.” Today, normalizing an empty list to `undefined` can cause **all** plugins (including the memory slot) to load for scoped CLI paths such as `openclaw status` / `openclaw health`. A core fix is to interpret “no channel plugins” as “load no channel plugins,” not “load everything.”
2. **CLI bootstrap policy** — Optionally load or activate **memory-slot** plugins only for gateway, agent/node runs, and explicit `hybrid-mem` (or equivalent), and not for unrelated operational CLI commands. This is a loader / CLI taxonomy decision.
3. **`activate: false`** — Core still invokes `register()` when building some reports; plugins should minimize work in `register()` for those paths, but **cannot** fully skip execution if core always imports and calls `register()`.

Link the upstream issue or PR here when filed: _(add URL)_.

## References

- Issue: [CLI: load hybrid-memory only for gateway, agents, and `hybrid-mem`](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1111)
