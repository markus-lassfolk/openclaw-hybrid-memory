# Release Notes — OpenClaw Hybrid Memory 2026.5.50

**Date:** 2026-05-05
**Previous baseline:** 2026.4.273

## Summary

**2026.5.50** is a compatibility and packaging release that closes four
externally reported issues against OpenClaw 2026.5.4+:

- **[#1171](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1171)** — ship a prebuilt `dist/` tree (compiled with `tsdown`) so OpenClaw's plugin loader accepts the package without users having to bundle the TypeScript source themselves.
- **[#1172](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1172)** — tighten the `openclaw` peerDependency to `>=2026.5.0 <2027` and add a CI smoke-install job that asserts `npm install openclaw-hybrid-memory openclaw@latest` resolves cleanly (no `@duckflux/core@^0.1.0` ETARGET, no required UNMET).
- **[#1173](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1173)** — silence the gateway's `http route registration missing path` warning by routing every `registerHttpRoute` call through a path-validating wrapper and registering the dashboard root without a trailing slash.
- **[#1174](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1174)** — resolve `package.json` from the plugin root (the directory containing `openclaw.plugin.json`) instead of relative to the runtime entry, so version reads work whether the runtime is the TS source or the compiled `dist/index.js`.

The published tarball now contains:

- `dist/index.js` (multi-file ESM tree, ~720 files preserving the source structure)
- `dist/index.d.ts` (and one `.d.ts` per source module)
- `dist/**/*.js.map` source maps
- `npm-shrinkwrap.json` (regenerated against the tightened peer)

`package.json#openclaw.extensions` now points at `./dist/index.js`, and `runtimeExtensions` is set to the same path for explicit 2026.5.4+ validation.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.5.50
```

If you previously worked around #1171 by running `esbuild --packages=external` over `index.ts` and copying `package.json` / `openclaw.plugin.json` into `dist/`, you can drop those steps — the published package now ships the compiled tree directly.

Restart the gateway after upgrading. If you use the standalone installer package, align its version with **2026.5.50** as well.

### Required gateway version

The plugin now requires **OpenClaw `>=2026.5.0 <2027`** (peer). If you are still on a 2026.3.x or 2026.4.x gateway, stay on `openclaw-hybrid-memory@2026.4.273` until you can upgrade the gateway.

---

## Notable internal changes

- New build step: `npm run build` runs `tsdown` and emits `dist/`. Triggered automatically by `npm pack` / `npm publish` via the `prepack` script.
- New helper `utils/plugin-root.ts` (`findPluginRoot`, `readPluginPackageJson`) replaces the brittle `join(dirname(fileURLToPath(import.meta.url)), "..")` pattern across `versionInfo.ts`, `setup/plugin-service.ts`, `cli/cmd-install.ts`, `cli/cmd-verify.ts`, `cli/cmd-config.ts`, and `utils/prompt-loader.ts`.
- New helper `tools/safe-register-http-route.ts` validates and normalizes route paths before they reach the gateway.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md) — search for **`2026.5.50`** for this release's section.
- [#1171](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1171) · [#1172](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1172) · [#1173](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1173) · [#1174](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1174)
