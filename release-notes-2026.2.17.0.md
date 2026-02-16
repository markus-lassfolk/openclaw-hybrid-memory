## 2026.2.17.0 (2026-02-17)

### Credential migration when vault is enabled

When you enable the credential vault (`credentials.encryptionKey` set), the plugin now **migrates** any credentials that were previously stored in memory into the vault and **redacts** them from the facts database and vector store:

- **Automatic (once):** On first load with the vault enabled, the plugin finds facts with entity `Credentials` that contain real secrets, stores each in the encrypted vault, removes the original fact from SQLite and LanceDB, and writes a pointer fact so the agent still knows the credential exists. A flag file (`.credential-redaction-migrated`) ensures this runs only once per install.
- **Manual:** Run `openclaw hybrid-mem credentials migrate-to-vault` anytime to run the same migration again (e.g. after adding credential facts with vault off, then enabling vault). Idempotent — already-pointer facts are skipped.

See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) § Migration.

### Model-agnostic analysis (documentation)

- [docs/MODEL-AGNOSTIC-ANALYSIS.md](docs/MODEL-AGNOSTIC-ANALYSIS.md) now documents the **Option B** exploration: the OpenClaw plugin SDK does not expose chat or embedding APIs, so "use OpenClaw for chat/embeddings" is not possible with the current SDK. The doc recommends Option C (multi-provider in the plugin) or requesting plugin-callable model/embed APIs from OpenClaw for a future Option B.
- **Decision:** We are not implementing model-agnostic setup for now; the plugin keeps hardcoded models (OpenAI for embeddings and chat, Gemini in docs/scripts for distillation). The analysis and options remain for future reference.

### Summary

| Area | Change |
|------|--------|
| Credentials | Migration into vault when enabled; CLI `credentials migrate-to-vault` |
| Docs | CREDENTIALS.md migration section; MODEL-AGNOSTIC-ANALYSIS Option B result and decision |
