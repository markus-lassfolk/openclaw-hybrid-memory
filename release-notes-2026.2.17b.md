## 2026.2.17b (2026-02-17) — bugfix

### Fixed

**Credentials (vault enabled):** When the vault is enabled, credential-like content that could not be parsed as a structured credential was still being written to memory (facts). It is now correctly skipped:

- **memory_store** tool: Returns a message and does not store; no secret is written to facts.
- **extract-daily** (session distillation): Skips the line; does not write to facts.
- **CLI `openclaw hybrid-mem store`**: Skips and exits with code 1 and an error message.

This ensures that when the vault is on, only successfully parsed credentials are stored in the vault with a pointer in memory; unparseable credential-like text is never written to facts.
