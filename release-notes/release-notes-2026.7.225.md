# v2026.7.225

## Fixed

- Harden deferred full-teardown activation database bootstrap against missing, blank, or non-string `lanceDbPath` and `sqlitePath` handoff values. Bootstrap now uses the documented parser defaults before calling the host path resolver and emits a concise actionable warning when it must fall back.
- Preserve deferred activation error source context safely in logs (generation, donor generation, staging/package metadata, and stack when available).

## Regression coverage

- Exercises a generation-2 deferred activation with omitted database paths, strict `resolvePath` input validation, and representative legacy dreaming fields; verifies activation reaches ready and legacy migration remains intact.
