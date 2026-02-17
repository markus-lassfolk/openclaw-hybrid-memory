# Credential Management (Opt-in)

The hybrid-memory plugin supports an **opt-in credential store** for structured, encrypted storage of API keys, tokens, passwords, and other authentication data.

## Dual-mode: Vault vs memory

- **Vault disabled (default):** Credentials are stored in memory like the live version: both **distil** (session distillation, extract-daily) and **store** (memory_store tool, `openclaw hybrid-mem store`) write credential-like content into the hybrid memory (SQLite + LanceDB). This matches the existing “store everything in memory” behavior.
- **Vault enabled:** When the secure credential vault is enabled (see below), credential-like content is **not** written into memory or the database. Instead:
  - The secret is stored only in the encrypted vault.
  - A **pointer** fact is stored in memory (e.g. “Credential for home-assistant (token) — stored in secure vault. Use credential_get(service=\"home-assistant\") to retrieve.”) so the agent knows the credential exists and how to retrieve it.
  - Recall and search return the pointer, not the secret; the agent uses `credential_get` when it needs the value.

So: **no vault** → credentials live in memory/facts (live behavior). **Vault on** → credentials live only in the vault; memory holds pointers only.

Dual-mode applies to: **memory_store** tool, **openclaw hybrid-mem store** (CLI and scripts such as session distillation), and **openclaw hybrid-mem extract-daily**.

## Migration: existing credentials into vault

When the vault is **enabled**, the plugin ensures that any credentials that were previously stored in memory (facts) are moved into the vault and **redacted** from their old locations:

- **On first load** (once per install): The plugin looks for facts with entity `Credentials` that contain real secrets (not already pointer text). For each one it: stores the secret in the encrypted vault, deletes the original fact from SQLite and LanceDB, and adds a new **pointer** fact so the agent still knows the credential exists and can use `credential_get`. A flag file (`.credential-redaction-migrated` in the memory directory) is written so this runs only once.
- **Manual run:** You can run the migration again anytime (e.g. after adding more credential facts with vault off, then enabling vault):

  ```bash
  openclaw hybrid-mem credentials migrate-to-vault
  ```

  This is idempotent: facts that are already pointers are skipped.

So when vault is enabled, **all** stored credentials end up only in the vault, with pointers in memory — including ones that were originally stored in memory before the vault was turned on.

## Enable

Set a valid **encryptionKey** in your memory-hybrid config; the credential store is **enabled automatically** when the key is set (or when the referenced env var is set). You can also set `"enabled": true` explicitly. To keep it off despite a key in config, set `"enabled": false`.

```json
{
  "credentials": {
    "store": "sqlite",
    "encryptionKey": "env:OPENCLAW_CRED_KEY",
    "autoDetect": true,
    "expiryWarningDays": 7
  }
}
```

- **encryptionKey**: `env:VAR_NAME` (e.g. `env:OPENCLAW_CRED_KEY`) or a 16+ character secret. When set and valid, the credential store is enabled automatically.
- **enabled** (optional): Set to `false` to disable even if encryptionKey is present.
- **autoDetect** (optional): When true, detects credential patterns (Bearer tokens, API keys, SSH) in conversation and prompts the agent to offer storing them
- **expiryWarningDays** (optional): Days before expiry to warn (default: 7)

**Required:** Set the `OPENCLAW_CRED_KEY` environment variable to a secret of at least 16 characters. This key is used to encrypt credentials at rest.

```bash
export OPENCLAW_CRED_KEY="your-secret-key-min-16-chars"
```

## API (Tools)

When enabled, four tools are registered:

| Tool | Description |
|------|-------------|
| `credential_store` | Store a credential (service, type, value, url?, notes?, expires?) |
| `credential_get` | Retrieve by service (optional type for disambiguation) |
| `credential_list` | List stored credentials (service/type/url only — no values) |
| `credential_delete` | Delete by service (optional type) |

### Credential Types

- `token`, `password`, `api_key`, `ssh`, `bearer`, `other`

### Examples

Store:
```
credential_store(service="home-assistant", type="token", value="eyJ...", url="http://localhost:8123")
credential_store(service="github", type="api_key", value="ghp_...", notes="Personal access token")
```

Get (exact lookup, no fuzzy search):
```
credential_get(service="home-assistant")
credential_get(service="github", type="api_key")
```

## Storage

- Credentials are stored in `credentials.db` next to your facts database (e.g. `~/.openclaw/memory/credentials.db`)
- Values are encrypted with AES-256-GCM
- Only service, type, url, notes, and expiry metadata are stored in plaintext

## Redaction

- **credential_get**: The credential value is returned only in `details.value` with `sensitiveFields: ["value"]`. The `content` text does not include the value, so it can be safely logged. Platforms should redact fields listed in `sensitiveFields` when persisting session transcripts or exporting.

## Auto-Detection

When `autoDetect` is enabled, the plugin scans conversation messages for patterns such as:
- Bearer/JWT tokens (`eyJ...`)
- OpenAI-style API keys (`sk-...`)
- GitHub tokens (`ghp_...`, `gho_...`)
- Slack tokens (`xoxb-...`, etc.)
- SSH connection strings (`ssh user@host`)

When detected, a hint is stored and injected at the start of the next turn, prompting the agent to offer storing the credential with `credential_store`.

## Expiry Warnings

- **credential_get**: When a credential has `expires` set and it's within `expiryWarningDays`, a warning is appended to the response.
- **credential_list**: Items expiring soon are flagged with an expiry date and a ⚠️ marker. A summary block lists how many credentials need rotation.

---

## Related docs

- [README](../README.md) — Project overview and all docs
- [CONFIGURATION.md](CONFIGURATION.md) — Credentials config settings
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `credentials migrate-to-vault` command
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — How distillation routes credentials to vault
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues
