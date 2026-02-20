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
        "dsn": "https://<key>@<host>/<project-id>",
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
https://42da747e-e18f-4ac6-bede-eda1a8079476@villapolly.duckdns.org/1
```

### Option 2: Sentry.io (Cloud)

If you prefer Sentry's cloud service:

1. Sign up at [sentry.io](https://sentry.io)
2. Create a new project (select Node.js)
3. Copy the DSN from the project settings

---

## What Gets Reported

### ✅ What IS Sent

- **Exception type** (e.g., `TypeError`, `DatabaseError`)
- **Sanitized error message** (secrets scrubbed, max 500 chars)
- **Sanitized stack trace** (only plugin paths, no absolute paths or context lines)
- **Plugin version** (e.g., `openclaw-hybrid-memory@2026.2.181`)
- **Environment tag** (e.g., `production`)
- **Operation context** (e.g., `subsystem: "vector-db"`, `operation: "store"`)

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
