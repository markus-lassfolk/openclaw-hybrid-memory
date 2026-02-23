# Error Reporting (GlitchTip/Sentry Integration)

**Status:** Optional, opt-in, privacy-first  
**Requires:** `@sentry/node` (optional peer dependency)  
**Default:** Disabled (consent required)

## Overview

The `openclaw-hybrid-memory` plugin supports optional error reporting to a self-hosted GlitchTip instance (or Sentry-compatible service). This feature helps identify and fix bugs by capturing exception details when things go wrong.

**🔒 Privacy is NON-NEGOTIABLE:**
- **Explicit opt-in required** — error reporting is disabled by default
- **No user prompts, memory text, or API keys** are ever sent
- **Strict allowlist approach** — only safe, sanitized data is reported
- **No tracking, no PII, no breadcrumbs** — your privacy is protected

---

## Configuration

Add the following to your `openclaw.json` (gateway config) or plugin config:

```json
{
  "plugins": {
    "openclaw-hybrid-memory": {
      "errorReporting": {
        "enabled": true,
        "consent": true,
        "dsn": "https://7d641cabffdb4557a7bd2f02c338dc80@villapolly.duckdns.org/1",
        "environment": "production",
        "sampleRate": 1.0
      }
    }
  }
}
```

### Config Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable error reporting |
| `consent` | boolean | **YES** | `false` | **Explicit user consent required** |
| `dsn` | string | Yes (if enabled) | — | GlitchTip/Sentry Data Source Name |
| `environment` | string | No | `"production"` | Environment tag (e.g., "development", "staging") |
| `sampleRate` | number | No | `1.0` | Sample rate (0.0–1.0). 1.0 = report all errors |
| `botId` | string | No | — | **Optional.** UUID for this bot instance (e.g. `550e8400-e29b-41d4-a716-446655440000`). Sent as a tag so GlitchTip can **group and filter errors by bot**. Omit to not tag by bot. Must be a valid UUID format. If unset, the plugin uses OpenClaw’s runtime context (`api.context.agentId`) when available; there is no hostname fallback (to avoid PII leakage). |
| `botName` | string | No | — | **Optional.** Friendly name for this bot (e.g. `Maeve`, `Doris`). Sent as a tag so reports show a readable name in GlitchTip. Max 64 characters. |

At plugin init the reporter applies `bot_id` / `bot_name` **tags** only (no Sentry user context), so GlitchTip can filter and group errors by bot without transmitting user identity. Example tag filter: `bot_name:Doris`.

### Setting via config-set

You can set any error-reporting key with the CLI so you don’t have to edit JSON by hand:

```bash
openclaw hybrid-mem config-set errorReporting.enabled true
openclaw hybrid-mem config-set errorReporting.consent true
openclaw hybrid-mem config-set errorReporting.botName Maeve
openclaw hybrid-mem config-set errorReporting.botId 550e8400-e29b-41d4-a716-446655440000
```

Use `true` / `false` for booleans. For help on a key:

```bash
openclaw hybrid-mem help config-set errorReporting.botName
```

Restart the gateway after changing config for it to take effect.

---

## Installation

The `@sentry/node` package is an **optional peer dependency**. If you want error reporting, install it:

```bash
cd extensions/memory-hybrid
npm install @sentry/node --save-optional
```

If `@sentry/node` is not installed, error reporting will be silently disabled (no crashes).

---

## Getting a DSN

### Option 1: Self-Hosted GlitchTip (Recommended)

GlitchTip is an open-source, self-hosted Sentry alternative.

1. **Deploy GlitchTip** (see [GlitchTip docs](https://glitchtip.com/documentation/install))
2. **Create an organization and project** in the web UI
3. **Copy the DSN** from the project settings

Example DSN format:
```
https://<key>@<your-glitchtip-host>/<project-id>
```

### Option 2: Sentry.io (Cloud)

If you prefer Sentry's cloud service:

1. Sign up at [sentry.io](https://sentry.io)
2. Create a new project (select Node.js)
3. Copy the DSN from the project settings

---

## Grouping errors by bot

If you run multiple bots (or gateways) and send errors to the same GlitchTip project, you can give each instance a stable **bot ID** (UUID) so events are tagged and you can group/filter by bot:

```json
"errorReporting": {
  "enabled": true,
  "consent": true,
  "botId": "550e8400-e29b-41d4-a716-446655440000",
  "botName": "Maeve"
}
```

- **botId**: Generate a UUID per bot (e.g. `uuidgen` on macOS/Linux, or [uuidgenerator.net](https://www.uuidgenerator.net/)) and set it in config. In GlitchTip, use the **bot_id** tag to filter or group issues by bot.
- **botName**: Set a friendly name (e.g. `Maeve`, `Doris`) so reports show a readable name in GlitchTip (sent as **bot_name** tag). Max 64 characters.

Omit either or both if you do not need them.

---

## What Gets Reported

### ✅ What IS Sent

- **Exception type** (e.g., `TypeError`, `DatabaseError`)
- **Sanitized error message** (secrets scrubbed, max 500 chars)
- **Sanitized stack trace** (only plugin paths, no absolute paths or context lines)
- **Plugin version** (e.g., `openclaw-hybrid-memory@2026.2.181`)
- **Environment tag** (e.g., `production`)
- **Operation context** (e.g., `subsystem: "vector-db"`, `operation: "store"`)
- **Bot ID** (optional): if you set `errorReporting.botId` to a UUID, it is sent as a tag so you can **group and filter errors by bot** in GlitchTip
- **Friendly name** (optional): if you set `errorReporting.botName` (e.g. `Maeve`, `Doris`), it is sent as a tag so reports show a readable name in GlitchTip

### ❌ What IS NOT Sent

- ❌ User prompts or memory text
- ❌ API keys, tokens, passwords
- ❌ Home directory paths (replaced with `$HOME`)
- ❌ Email addresses (replaced with `[EMAIL]`)
- ❌ IP addresses (replaced with `[IP]`)
- ❌ Breadcrumbs (can contain user data)
- ❌ HTTP requests or console logs
- ❌ User identity, device info, or session data

---

## Privacy Guarantees

The error reporter implements **defense-in-depth** privacy:

### Layer 1: Configuration

- `sendDefaultPii: false` — no personally identifiable information
- `maxBreadcrumbs: 0` — breadcrumbs can contain user prompts
- `autoSessionTracking: false` — no session tracking
- `integrations: []` — all default integrations disabled (they capture too much)

### Layer 2: beforeBreadcrumb Hook

Returns `null` to drop ALL breadcrumbs.

### Layer 3: beforeSend Hook (Allowlist)

Rebuilds the event from scratch using a strict allowlist:

1. **Only safe fields are kept** (event ID, timestamp, platform, level, release, environment)
2. **Exception messages are scrubbed** via `scrubString()` to remove:
   - API keys (`sk-xxx`, `ghp_xxx`, `Bearer xxx`)
   - Home paths (`/home/user`, `/Users/user`, `C:\Users\user`)
   - Emails (replaced with `[EMAIL]`)
   - IPs (replaced with `[IP]`)
3. **Stack traces are sanitized** via `sanitizePath()` to keep only plugin-relative paths
4. **All other fields are dropped** (user, request, breadcrumbs, device, extra)

### Layer 4: Testing

The test suite (`tests/error-reporter.test.ts`) verifies:

- No initialization without explicit consent
- Sanitization functions remove secrets
- Privacy settings are enforced

---

## Example Usage

### Automatic (Transparent)

Once configured, errors are automatically captured when exceptions occur in the plugin. You don't need to do anything.

### Manual (Rare)

If you're extending the plugin and want to report custom errors:

```typescript
import { capturePluginError } from "./services/error-reporter.js";

try {
  // Your code here
} catch (error) {
  capturePluginError(error as Error, {
    subsystem: "my-feature",
    operation: "custom-operation",
    configShape: { someFlag: "true" }, // Safe metadata only
  });
  throw error; // Re-throw to preserve existing behavior
}
```

---

## FAQ

### Q: Is this enabled by default?

**No.** Error reporting is **disabled by default** and requires explicit `consent: true` in the config.

### Q: Can I use this without self-hosting?

Yes, you can use [sentry.io](https://sentry.io) cloud service instead of self-hosting GlitchTip. Just use their DSN.

### Q: What if I don't install `@sentry/node`?

Error reporting will be silently disabled. The plugin will log a warning and continue normally.

### Q: How do I test if it's working?

1. Set `enabled: true` and `consent: true` in your config
2. Restart OpenClaw gateway: `openclaw gateway restart`
3. Trigger a test error (e.g., store a fact with invalid data)
4. Check your GlitchTip/Sentry dashboard for the error

### Q: Can I disable it after enabling?

Yes. Set `enabled: false` or `consent: false` in your config and restart the gateway.

### Q: Does this impact performance?

No. Error reporting only activates when an exception occurs (rare). The sanitization overhead is negligible.

### Q: What about memory usage?

The `@sentry/node` SDK is lazy-loaded only if error reporting is enabled. If disabled, it's not loaded at all.

---

## Security Audit Checklist

If you're auditing this feature for security/privacy compliance, verify:

- [ ] `consent: false` by default (user must opt in)
- [ ] `sendDefaultPii: false` always
- [ ] `maxBreadcrumbs: 0` (breadcrumbs can contain prompts)
- [ ] `integrations: []` (default integrations disabled)
- [ ] `beforeSend` rebuilds event with allowlist (not blocklist)
- [ ] `beforeBreadcrumb` returns `null` (drop all)
- [ ] `scrubString()` removes API keys, emails, IPs, paths
- [ ] `sanitizePath()` keeps only plugin-relative paths
- [ ] Test suite includes PII leak prevention tests

---

## Troubleshooting

### "Error reporting enabled" doesn't appear in logs

**Cause:** The `@sentry/node` package is not installed, or the config is invalid.

**Fix:**
1. Install `@sentry/node`: `npm install @sentry/node --save-optional`
2. Verify your DSN is correct
3. Check that `enabled: true`, `consent: true`, and `dsn` is set
4. Restart the gateway: `openclaw gateway restart`

### Errors aren't showing up in GlitchTip

**Cause:** Network connectivity, invalid DSN, or rate limiting.

**Fix:**
1. Test the DSN: `curl https://your-glitchtip-domain/api/`
2. Check firewall/proxy settings
3. Verify the GlitchTip project exists and is active
4. Check OpenClaw logs for Sentry initialization errors

### "Subagent main failed" (or other Cursor/IDE errors) — nothing in GlitchTip

**Cause:** The plugin’s error reporter runs only inside the **OpenClaw gateway process** when the plugin is loaded. It does **not** run in Cursor’s subagent processes (e.g. `mcp_task` / explore / shell agents). Those run in separate processes that never load this plugin, so they never call `capturePluginError()` and nothing is sent to GlitchTip.

**What gets reported:** Only errors that occur in plugin code (tools, hooks, CLI, chat, DB init, etc.) **inside the gateway** and that are caught by a path that calls `capturePluginError()`.

**What does not:** Cursor IDE subagent failures, timeouts, or crashes in other processes. For those, check Cursor’s own logs or output; they are outside this plugin’s scope.

### Too many errors being reported

**Cause:** High error rate or missing error handling.

**Fix:**
1. Lower `sampleRate` (e.g., `0.1` = 10% of errors)
2. Add try/catch blocks to handle expected errors gracefully
3. Use rate limiting in GlitchTip/Sentry

---

## References

- [GlitchTip Documentation](https://glitchtip.com/documentation)
- [Sentry Node.js SDK](https://docs.sentry.io/platforms/node/)
- [OpenClaw Plugin Development Guide](https://github.com/markus-lassfolk/openclaw)

---

**Built with privacy-first principles.**  
If you have questions or concerns, please [open an issue](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues).
