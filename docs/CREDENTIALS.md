---
layout: default
title: Credential Vault
parent: Features
nav_order: 2
---
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
    "autoCapture": {
      "toolCalls": true,
      "logCaptures": true
    },
    "expiryWarningDays": 7
  }
}
```

- **encryptionKey**: `env:VAR_NAME` (e.g. `env:OPENCLAW_CRED_KEY`) or a 16+ character secret. When set and valid, the credential store is enabled automatically.
- **enabled** (optional): Set to `false` to disable even if encryptionKey is present.
- **autoDetect** (optional): When true, detects credential patterns (Bearer tokens, API keys, SSH) in conversation and prompts the agent to offer storing them
- **autoCapture** (optional): Auto-capture credentials directly from tool call inputs (see [Auto-Capture from Tool Calls](#auto-capture-from-tool-calls) below)
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

### Key Derivation (KDF)

The encryption key is derived from your `encryptionKey` config using a **key derivation function**:

- **v2 (current, scrypt):** New vaults use scrypt (N=16384, r=8, p=1) with a random 32-byte salt. The KDF version and salt are stored in the `vault_meta` table.
- **v1 (legacy, SHA-256):** Earlier versions derived the key using a single SHA-256 hash (no salt). This is weaker and is automatically migrated.

### Automatic KDF migration (v1 → v2)

If you have an existing vault created before scrypt support was added, it will be **automatically migrated** to scrypt on the first successful `credential_get` call:

1. The plugin detects the vault has no `vault_meta` entries (legacy vault).
2. On the first successful decryption (proving the password is correct), all credentials are re-encrypted with a new scrypt-derived key and random salt.
3. The new KDF version and salt are written to `vault_meta`.

This migration is **transparent** — no action required. After migration, all subsequent operations use the stronger scrypt KDF.

## Redaction

- **credential_get**: The credential value is returned only in `details.value` with `sensitiveFields: ["value"]`. The `content` text does not include the value, so it can be safely logged. Platforms should redact fields listed in `sensitiveFields` when persisting session transcripts or exporting.

## Auto-Capture from Tool Calls

When `autoCapture.toolCalls` is enabled, the plugin scans **tool call inputs** (what the agent sends to tools) for credential patterns and stores them in the vault immediately — no prompting required, since the agent already used the credential openly.

This solves the problem of credentials getting lost between sessions: the agent uses them in tool calls (exec commands, API calls, etc.) but never explicitly mentions them in conversation text.

### Enable

```json
{
  "credentials": {
    "encryptionKey": "env:OPENCLAW_CRED_KEY",
    "autoCapture": {
      "toolCalls": true,
      "logCaptures": true
    }
  }
}
```

**Config options:**
- `toolCalls`: Enable scanning of tool call inputs (default: `false`, opt-in)
- `logCaptures`: Emit an info-level log on each capture (default: `true`)

Pattern matching currently uses a built-in pattern set and is not configurable via `credentials.autoCapture`.

### Detection Patterns

The following tool input patterns are detected and stored automatically:

| Pattern | Type | Service |
|---------|------|---------|
| `sshpass -p <pass> ssh user@host` | `password` | `ssh://user@host` |
| `curl -H "Authorization: Bearer <token>" <url>` | `bearer` | hostname from URL |
| `curl -u user:pass <url>` | `password` | hostname from URL |
| `-H "X-API-Key: <key>"` | `api_key` | hostname from URL |
| `postgres://user:pass@host/db` (also mysql, mongodb, redis, mssql) | `password` | `proto://host/db` |
| `export VAR_KEY=value`, `export VAR_TOKEN=value`, `export VAR_PASSWORD=value`, `export VAR_SECRET=value` | `api_key` / `token` / `password` / `other` | derived from var name |
| `.env`-style `VAR_KEY=value` assignments | `api_key` / `token` / `password` / `other` | derived from var name |

### Behavior

1. The plugin registers an `agent_end` hook that scans all `tool_calls[*].function.arguments` in assistant messages.
2. When a credential pattern is found, the value is extracted along with service name (hostname, connection string, or variable-derived slug) and type.
3. The credential is stored in the vault via `credentialsDb.store()` — an **upsert** on `(service, type)`, so repeated captures update the value without creating duplicates.
4. A confirmation log is emitted: `memory-hybrid: auto-captured credential for ssh://root@192.168.1.19 (password)`.
5. Credential values are **never** written to the facts DB or vector DB — vault only.

### Security Notes

- Only **tool inputs** are scanned — never tool outputs (which may contain unrelated secrets in command logs, etc.).
- Respects the `credentials.enabled` gate — if vault is disabled, no capture occurs.
- Credential values are encrypted with AES-256-GCM in the vault.

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
