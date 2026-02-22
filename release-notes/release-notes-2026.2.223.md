## 2026.2.223 (2026-02-22)

Patch release: align CLI-context `fallbackModels` with `cfg.llm` so gateway-routed model config is respected consistently (fixes inconsistent model selection between CLI reflection and other code paths).

---

### Fixed

- **CLI-context fallbackModels:** When `cfg.llm` is set, `runReflection`, `runReflectionRules`, and `runReflectionMeta` now use no legacy fallbacks (same as `handlers.ts` and `utility-tools.ts`). Previously they always fell back to `cfg.distill?.fallbackModels`, mixing new `llm` config with legacy distill fallbacks.

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.223`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.223
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.223
```

Restart the gateway after upgrading.
