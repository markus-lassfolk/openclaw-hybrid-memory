# Auto-Recall on Authentication Failures

## Overview

**Feature Status:** ✅ Implemented (v2026.2.176+)

The **Authentication Failure Auto-Recall** feature is a reactive memory trigger that automatically injects relevant credentials from memory when the agent encounters authentication failures in tool results.

## Problem

When an agent encounters authentication failures (SSH "Permission denied", HTTP 401/403, expired API keys), it often:
- Retries with guessed credentials
- Gives up without checking its own memory
- Loses context about where credentials were previously stored

## Solution

A reactive recall trigger that:
1. **Detects** authentication failure patterns in tool results
2. **Extracts** the target identifier (hostname, URL, IP, service name)
3. **Searches** memory for relevant credentials
4. **Injects** a hint with matching facts before the next agent turn

## How It Works

### 1. Detection Layer

The plugin scans prompts and recent messages for authentication failure patterns:

**SSH Patterns:**
- "Permission denied"
- "Authentication failed"
- "publickey,password"
- "Host key verification failed"

**HTTP Patterns:**
- Status codes: `401`, `403`
- Messages: "Unauthorized", "Forbidden"

**API Patterns:**
- "Invalid API key"
- "token expired", "token invalid"
- "invalid_auth", "authentication required"

### 2. Target Extraction

When an auth failure is detected, the system extracts the target identifier:
- **IP addresses** (highest priority): `192.168.1.100`
- **Hostnames from SSH**: `user@example.com` → `example.com`
- **URLs**: `https://api.github.com/user` → `api.github.com`
- **Service names**: "for OpenAI service" → `openai`

### 3. Memory Recall

The system builds a search query combining:
- The extracted target
- Credential-related terms: "credential", "password", "token", "key", "auth"

Search covers both:
- SQLite FTS5 (structured facts)
- LanceDB vector search (semantic matching)

Results are filtered to credential/technical facts:
- Category: `technical`
- Entity: `Credentials`
- Tags: `credential`, `ssh`, `token`, `api`, `auth`, `password`

### 4. Context Injection

Matching credentials are formatted as a system hint:

```
💡 Memory has credentials for example.com:
  1. SSH credentials for example.com: user=admin, key=/path/to/key
  2. API token for example.com API
```

This hint is injected as prepended context before the next agent turn.

### 5. Deduplication

To avoid spam, the system tracks recalls per target per session:
- Default: 1 recall per target
- Configurable via `maxRecallsPerTarget`

## Configuration

### Enable/Disable

The feature is **enabled by default** when `autoRecall` is enabled.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "autoRecall": {
            "enabled": true,
            "authFailure": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

### Customize Patterns

Add custom auth failure patterns:

```json
{
  "autoRecall": {
    "authFailure": {
      "enabled": true,
      "patterns": [
        "Permission denied",
        "401",
        "403",
        "access denied",
        "authentication required"
      ]
    }
  }
}
```

Patterns are case-insensitive regex strings.

### Deduplication

Control how many times credentials are recalled per target:

```json
{
  "autoRecall": {
    "authFailure": {
      "maxRecallsPerTarget": 1  // Default: 1 recall per session
    }
  }
}
```

Set to `0` for unlimited recalls (not recommended).

### Vault Integration

When the credential vault is enabled, the system can still inject hints about vault-stored credentials:

```json
{
  "autoRecall": {
    "authFailure": {
      "includeVaultHints": true  // Default: true
    }
  }
}
```

Even if the credential value is encrypted in the vault, the hint will tell the agent:
> "Credential for example.com (ssh) — stored in secure vault. Use credential_get(service="example.com") to retrieve."

## Scope awareness

The feature respects memory scoping:
- **Orchestrator agents**: See all credentials (global scope)
- **Specialist agents**: See only global + agent-specific credentials
- **Session-scoped**: Not injected by auth failure recall (security)

This prevents credential leakage between agents or sessions.

## Example Scenarios

### Scenario 1: SSH Failure

**Tool Result:**
```
$ ssh admin@production-server.example.com
Permission denied (publickey,password).
```

**System Action:**
1. Detects: SSH permission denied
2. Extracts target: `production-server.example.com`
3. Searches memory for: `production-server.example.com credential password token key`
4. Finds: "SSH key stored at ~/.ssh/prod_key for production-server.example.com"
5. Injects hint before next turn

**Agent Response:**
> "I see the permission denied error. Let me check my memory... I have the SSH key stored at ~/.ssh/prod_key. Let me try with that key."

### Scenario 2: API Token Expired

**Tool Result:**
```
HTTP GET https://api.openai.com/v1/models
Response: 401 Unauthorized
{"error": {"message": "Invalid API key provided"}}
```

**System Action:**
1. Detects: HTTP 401 + "Invalid API key"
2. Extracts target: `api.openai.com`
3. Searches: `api.openai.com credential password token key auth`
4. Finds: Vault pointer for "openai" credentials
5. Injects hint: "Credential for openai (api_key) — stored in secure vault..."

**Agent Response:**
> "The API key is invalid. I'll retrieve the stored key from the vault using credential_get."

### Scenario 3: No Credentials Found

**Tool Result:**
```
ssh newserver.local
Permission denied (publickey).
```

**System Action:**
1. Detects: SSH permission denied
2. Extracts target: `newserver.local`
3. Searches memory: No matching facts
4. Logs: "memory-hybrid: no credential facts found for newserver.local"
5. No injection (agent handles gracefully)

**Agent Response:**
> "I don't have credentials for newserver.local in my memory. Could you provide them?"

## Security Considerations

### What's NOT Included

The auth failure recall system follows these security rules:

1. **No credential values in logs**
   - Only logs target identifiers (hostnames, IPs)
   - Never logs secrets, tokens, passwords

2. **Scoped access**
   - Respects memory scoping (global + agent-specific)
   - Agents only see credentials in their scope

3. **Vault respect**
   - Does not decrypt vault credentials
   - Injects hints pointing to `credential_get` tool

4. **No auto-execution**
   - Only injects hints, never auto-submits credentials
   - Agent must explicitly use the recalled information

## Testing

The feature includes comprehensive tests:

```bash
npm test -- auth-failure-detect.test.ts
```

**Test Coverage:**
- ✅ Pattern detection (SSH, HTTP, API)
- ✅ Target extraction (hostnames, IPs, URLs, service names)
- ✅ Query building
- ✅ Hint formatting
- ✅ Integration scenarios
- ✅ Edge cases (no target, no credentials)

## Performance

**Overhead per agent turn:**
- Detection: ~1ms (regex matching)
- Search: ~10-50ms (SQLite FTS + LanceDB vector search)
- Total: Negligible impact (<0.1% of typical agent turn)

**Deduplication** ensures the overhead only applies once per unique target per session.

## Troubleshooting

### Issue: Auth failures not detected

**Check:**
1. Is `autoRecall.enabled` true?
2. Is `autoRecall.authFailure.enabled` true?
3. Are your custom patterns valid regex?

**Debug:**
```bash
# Check plugin logs
tail -f ~/.openclaw/logs/gateway.log | grep "auth failure"
```

### Issue: Wrong target extracted

**Example:**
```
"Failed to connect to server" → extracts "server" (too generic)
```

**Solutions:**
1. Ensure target info is in the tool result (hostname, IP, URL)
2. Store credentials with multiple identifiers (hostname + IP)
3. Use explicit service names in memory facts

### Issue: Credentials recalled but agent doesn't use them

**Possible causes:**
1. Agent model lacks instruction-following capability
2. Hint format is unclear for the agent
3. Agent lacks tools to use credentials (e.g., no `credential_get`)

**Solutions:**
1. Use a stronger model (GPT-4, Claude Opus)
2. Add explicit instructions in `SOUL.md`: "When you see 💡 memory hints, use that information"
3. Enable credential vault + tools

## Backward Compatibility

The feature is **fully backward compatible**:
- Enabled by default (opt-out via config)
- No behavior change for users without stored credentials
- Works with or without credential vault
- Safe to deploy without configuration changes

## Future Enhancements

Potential improvements (out of scope for this feature):

1. **Multi-step auth flows**: Track auth context across multiple turns
2. **Credential validation**: Detect when recalled credentials also fail
3. **Learning from success**: Automatically tag working credentials
4. **URL pattern matching**: Detect similar API endpoints (e.g., `api.v1.example.com` matches `api.v2.example.com`)

## Related Features

- **Memory scoping**: Used for credential access control (global + agent-specific)
- **Credential vault**: Encrypted credential storage (optional integration)
- **Auto-recall**: Base memory injection system
- **FTS5 + LanceDB**: Dual backend for fast + semantic search

## References

- Issue: [#47](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/47)
- Code: `extensions/memory-hybrid/services/auth-failure-detect.ts`
- Tests: `extensions/memory-hybrid/tests/auth-failure-detect.test.ts`
- Config: `extensions/memory-hybrid/config.ts` (`AutoRecallConfig.authFailure`)
