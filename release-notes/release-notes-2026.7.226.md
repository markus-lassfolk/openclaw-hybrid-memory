# Release notes — 2026.7.226

## Fixed

The lockstep standalone installer now stages a complete package extracted from the npm tarball in `~/.openclaw/.cache` before it runs `npm install --omit=dev`. It verifies that the staged `package.json` exists and is valid JSON, failing before npm with a clear packaging diagnosis when it does not.

Only the completed package is moved into `~/.openclaw/extensions/openclaw-hybrid-memory`; temporary staging and rollback trees remain outside the extension scanner. This resolves the Doris v2026.7.225 upgrade incident, where npm received a staging directory without a manifest and exited `ENOENT` before activation.
