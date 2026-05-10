# Service Markers and CLI Availability (Issue #1209)

## Problem

When environment variables `OPENCLAW_SERVICE_KIND` or `OPENCLAW_SERVICE_MARKER` are present, the OpenClaw CLI framework treats the invocation as a service/gateway context and **skips loading plugin CLIs entirely**. This causes `openclaw hybrid-mem` commands to fail with:

```
Error: Unknown command: openclaw hybrid-mem. No built-in command or plugin CLI metadata owns "hybrid-mem".
```

## Root Cause

The OpenClaw CLI framework (external to this plugin) checks for these environment markers during plugin discovery and, when present, assumes the process is running as a service/gateway where CLI commands should not be available. This is by design for security and resource reasons.

## Why This Happens in Cron/Service Contexts

Service markers can leak into CLI invocations in several ways:

1. **Cron jobs spawned by a gateway/service** - The parent process's environment is inherited
2. **Systemd service units** - Environment variables defined in service files leak to child processes
3. **Docker containers** - Environment variables set in docker-compose or Kubernetes manifests
4. **Shell rc files** - If `.bashrc` or `.zshrc` exports these variables

## Solution: Environment Sanitization

### For Cron Jobs (Recommended)

The plugin's cron harness automatically sanitizes the environment by wrapping `openclaw` calls:

```bash
openclaw() {
  local openclaw_bin
  openclaw_bin="$(type -P openclaw)" || return 127
  env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI \
      -u OPENCLAW_CLI \
      -u OPENCLAW_SERVICE_KIND \
      -u OPENCLAW_SERVICE_MARKER \
      "$openclaw_bin" "$@"
}
```

This wrapper is automatically included when you:
- Use `openclaw hybrid-mem verify --fix` to install/update cron jobs
- Use the plugin's built-in cron task generators

### For Manual Invocations

If you need to run `openclaw hybrid-mem` commands in an environment where these markers are set, use this wrapper:

```bash
# Option 1: Inline wrapper (one-time use)
env -u OPENCLAW_SERVICE_KIND -u OPENCLAW_SERVICE_MARKER openclaw hybrid-mem stats

# Option 2: Shell function (reusable)
openclaw-cli() {
  env -u OPENCLAW_SKIP_HYBRID_MEMORY_CLI \
      -u OPENCLAW_CLI \
      -u OPENCLAW_SERVICE_KIND \
      -u OPENCLAW_SERVICE_MARKER \
      openclaw "$@"
}
openclaw-cli hybrid-mem stats

# Option 3: Clean environment subshell
(unset OPENCLAW_SERVICE_KIND OPENCLAW_SERVICE_MARKER; openclaw hybrid-mem stats)
```

### For Systemd Services

Add this to your service unit file to prevent marker leakage to spawned commands:

```ini
[Service]
UnsetEnvironment=OPENCLAW_SERVICE_KIND OPENCLAW_SERVICE_MARKER
```

## Why `bash -lc` Doesn't Help

The verification test attempted:

```bash
bash -lc 'env -u ... openclaw hybrid-mem stats'
```

This fails because:
1. `bash -lc` sources login scripts (`.bash_profile`, `.bashrc`)
2. These scripts may re-export the environment variables
3. The `env -u` happens **inside** the login shell, after variables are already reloaded

## Verification Testing

To test that `openclaw hybrid-mem` commands work correctly:

```bash
# Good: Markers unset before openclaw invocation
env OPENCLAW_HOME=/path/to/.openclaw \
  bash -c 'unset OPENCLAW_SERVICE_KIND OPENCLAW_SERVICE_MARKER; openclaw hybrid-mem stats'

# Bad: Markers present during openclaw invocation
env OPENCLAW_SERVICE_KIND=gateway \
    OPENCLAW_SERVICE_MARKER=1 \
    openclaw hybrid-mem stats  # Will fail!
```

## Plugin Behavior

The plugin correctly registers CLI metadata even when service markers are present **during plugin registration**. However, the OpenClaw CLI framework must call `register()` in the first place, and it won't do that if markers are present at CLI startup.

## Summary

- **Service markers prevent OpenClaw from loading plugin CLIs** (by design, in the OpenClaw CLI framework)
- **The plugin's cron harness correctly sanitizes the environment** via the `openclaw()` wrapper function
- **Direct invocations must manually unset markers** before calling `openclaw hybrid-mem`
- **This is not a plugin bug** - the sanitizer is working correctly; verification tests must use clean environments

## Related Issues

- Issue #1209: Original report about hybrid-mem CLI disappearing in cron/service contexts
- Issue #1205: Cron environment sanitization requirements
