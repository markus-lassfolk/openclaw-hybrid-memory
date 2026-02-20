## 2026.2.201 (2026-02-20)

Bug-fix release: credentials encryption key handling and config mode reporting for verify.

---

### Fixed

**Credentials: no silent fallback when encryption key is invalid or unresolved.**

- When `credentials.enabled: true` and the user sets an `encryptionKey` that is invalid or unresolved (e.g. `env:MY_VAR` with `MY_VAR` unset, or a raw key shorter than 16 characters), the plugin now **throws** at config load with a clear error instead of silently falling back to memory-only (which would have stored credentials in plain SQLite).
- Memory-only mode (capture only, no persistent vault) is only used when credentials are enabled and **no** `encryptionKey` is set.
- Error messages direct users to set the env var or use a key of at least 16 characters, and mention `openclaw hybrid-mem verify --fix`.

**Config mode: verify reports "Mode: Custom" when preset values are overridden.**

- When a user specifies a configuration mode (e.g. `"normal"`) but overrides one or more preset values, the resolved config’s `mode` field is now set to `"custom"` so that `openclaw hybrid-mem verify` correctly shows **Mode: Custom**.
- Previously the ternary could leave `mode` as the named preset in edge cases; it now consistently uses `hasPresetOverrides ? "custom" : appliedMode`, matching the behavior documented in CONFIGURATION-MODES.md.

---

### Changed

- **Version bump** — Release 2026.02.20 revision (npm `2026.2.201`). Version numbers updated in package.json, openclaw.plugin.json, and package-lock.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.201
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.201
```

Restart the gateway after upgrading.
