## 2026.3.72 (2026-03-07)

Release workflow fix: publish step no longer fails when package version already matches the tag.

---

### What’s in this release

- **Release workflow** — "Set package version" runs only when package.json version differs from the release tag, fixing `npm error Version not changed` that could block NPM publish.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.3.72
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.72
```

Restart the gateway after upgrading.
