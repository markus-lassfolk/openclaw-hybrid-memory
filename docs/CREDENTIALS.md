# Credential Management (Opt-in)

The hybrid-memory plugin supports an **opt-in credential store** for structured, encrypted storage of API keys, tokens, passwords, and other authentication data.

## Enable

Add to your memory-hybrid config:

```json
{
  "credentials": {
    "enabled": true,
    "store": "sqlite",
    "encryptionKey": "env:OPENCLAW_CRED_KEY",
    "autoDetect": true,
    "expiryWarningDays": 7
  }
}
```

- **encryptionKey** (required when enabled): `env:VAR_NAME` or a 16+ character secret
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
