## 2026.2.175 (2026-02-17)

### Added

**`openclaw hybrid-mem upgrade`** — One-command upgrade to latest from npm. Removes current install, fetches latest, rebuilds native deps. Restart gateway afterward. Simplifies the upgrade flow (no more fighting the bull).

### Fixed

- **Postinstall:** Replaced shell rebuild with `scripts/postinstall-rebuild.cjs`. No more silent failures (`2>/dev/null || true`); clear errors on rebuild failure. Script included in published package via `scripts` in `files`.

### Changed

- **Documentation:** CLI-REFERENCE lists `upgrade`; UPGRADE-PLUGIN recommends `openclaw hybrid-mem upgrade` as primary method; extension README updated.
- **Tests:** Added `postinstall.test.ts` to verify postinstall script and `scripts` in package files.
