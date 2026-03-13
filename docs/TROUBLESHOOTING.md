---
layout: default
title: Troubleshooting
parent: Operations & Maintenance
nav_order: 8
---
# Troubleshooting

Common issues, causes, and fixes for the memory-hybrid plugin.

---

## Quick diagnostics

```bash
openclaw hybrid-mem verify        # check config, DBs, API key
openclaw hybrid-mem verify --fix  # apply safe auto-fixes
openclaw hybrid-mem stats         # show fact/vector counts
```

---

## WSL2 / no systemd: run gateway under cron (last-known-good recovery)

On **WSL2** or in **containers**, `systemctl --user` is often unavailable (`Failed to connect to bus: No medium found`). The gateway should **not** be run as a systemd service; run it in the foreground or let a **cron watchdog** start and supervise it.

- **Log messages you can ignore:** "systemd user services unavailable", "run the gateway in the foreground instead of openclaw gateway", "Cleanup hint: systemctl --user disable …". As long as you see "Listening: 127.0.0.1:18789" and "web gateway heartbeat", the gateway is fine.
- **Recommended:** Use the **cron-only watchdog** so that every 5 minutes something checks if the gateway is responsive and, if not, restores one of the last 3 known-good configs and starts the gateway with `openclaw gateway run`. That way a bad config edit is auto-recovered. See [scripts/README.md](../scripts/README.md#gateway-watchdog-cron-only-no-systemd): copy `scripts/gateway-watchdog-cron.sh` to `~/.openclaw/scripts/`, make it executable, and add one crontab entry. Do not use `openclaw gateway start` (systemd) together with this watchdog.

---

## Gateway crashes / CLI: "gateway closed (1006 abnormal closure)"

If the CLI fails with **"Failed to start CLI: Error: gateway closed (1006 abnormal closure (no close frame))"** and gateway target `ws://127.0.0.1:18789`, the gateway process is either **not running** or is crashing (often immediately after start or when loading plugins). **Most often the gateway simply isn't running** — start it first in a separate terminal (see below), then run your CLI command.

### Step 1: Run the gateway in the foreground to see the real error

In a **dedicated terminal**, run the gateway in the foreground so you see stdout/stderr:

```bash
openclaw gateway run
```

Leave this terminal open. Watch for:

- **"Listening: 127.0.0.1:18789"** and **"web gateway heartbeat"** — gateway is up; the earlier CLI error was likely "gateway not running". In a second terminal run your CLI command (e.g. `openclaw hybrid-mem verify`).
- **Crash or stack trace** — note the last lines (e.g. missing module, config error, native bindings).

Common crash causes and fixes:

| What you see | Cause | Fix |
|--------------|--------|-----|
| `Cannot find module 'better-sqlite3'` or `Could not locate bindings file (better_sqlite3.node)` | Extension native deps not built or wrong path | `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm install && npm rebuild better-sqlite3 @lancedb/lancedb`. Then run `openclaw gateway run` again from the gateway install (e.g. same Node as `openclaw`). |
| `Cannot find module '@lancedb/lancedb'` or `@sinclair/typebox` | Extension deps not installed | `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm install`. Restart gateway. |
| `embedding.apiKey is required` or plugin config error | Plugin throws at load | Edit `~/.openclaw/openclaw.json`: add valid `embedding.apiKey` and `embedding.model` under `plugins.entries["openclaw-hybrid-memory"].config`. Or temporarily set `plugins.entries["openclaw-hybrid-memory"].enabled` to `false` to confirm the rest of the gateway starts. |
| `invalid config` / schema validation error | Core or plugin config schema | Fix or simplify the offending key in `openclaw.json`; if you use hybrid-memory, ensure the plugin's `openclaw.plugin.json` has `additionalProperties: true` in `configSchema` (see [Common issues](#common-issues)). |
| **"non-loopback Control UI requires gateway.controlUi.allowedOrigins"** or **"set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"** | Gateway treats the host as non-loopback (e.g. WSL2 hostname) and refuses to start the Control UI without explicit CORS/origin config | Add to `openclaw.json` at the top level: `"gateway": { "controlUi": { "dangerouslyAllowHostHeaderOriginFallback": true } }` for local-only use, or set `"allowedOrigins": ["http://localhost:18789", "http://127.0.0.1:18789", "…"]` with your actual origins. Then run `openclaw gateway run` again. |
| Process exits with no message | Possible crash in native code or during plugin init | Run `openclaw gateway run` under Node with more visibility: `NODE_OPTIONS='--trace-warnings' openclaw gateway run` or check `~/.openclaw/logs/` if your setup writes logs there. |
| **"another gateway instance is already listening on ws://..."** then process exits | Duplicate-start detection or stale lock; gateway exits shortly after binding the port | Stop everything: `openclaw gateway stop`. In a **single** terminal run `openclaw gateway run` and leave it running (do not use both systemd and watchdog, or multiple `gateway run`). Use a **second** terminal for `openclaw status -deep`, `openclaw hybrid-mem verify`, etc. |
| **"FATAL ERROR: Reached heap limit" / "JavaScript heap out of memory"** (often with ~4 GB in "Last few GCs") | Node.js process (gateway or CLI) exceeded V8 heap limit; can cause abrupt exit → CLI sees 1006 | **Immediate:** Run the gateway with a higher heap: `NODE_OPTIONS='--max-old-space-size=8192' openclaw gateway run` (8 GB). Reduce memory pressure: lower `agents.defaults.bootstrapMaxChars` / `bootstrapTotalMaxChars`, `contextTokens`, or auto-recall token budget in plugin config. See [Gateway or CLI runs out of memory (OOM)](#gateway-or-cli-runs-out-of-memory-oom) below. |

### Step 2: WSL2 / no systemd — don’t use `gateway start`

On **WSL2**, `openclaw gateway start` may try systemd and fail; the gateway never stays running, so the CLI gets 1006 when it connects.

- **Use the foreground gateway:** In one terminal run `openclaw gateway run` and leave it running; use a second terminal for CLI/agent.
- **Or use the cron watchdog:** It starts the gateway with `openclaw gateway run` in the background and restores last-known-good config if the gateway doesn’t come up. See [Gateway watchdog (cron-only, no systemd)](../scripts/README.md#gateway-watchdog-cron-only-no-systemd).

### Step 3: After the gateway stays up

Once `openclaw gateway run` shows "Listening: 127.0.0.1:18789" and doesn’t crash:

- **In a second terminal** run `openclaw status -deep`, `openclaw hybrid-mem verify`, or any other CLI command. The 1006 error goes away as long as the gateway is still running in the first terminal.
- To run the gateway in the background without cron: `nohup openclaw gateway run >> ~/.openclaw/logs/gateway.log 2>&1 &` (create `~/.openclaw/logs` if needed). If the gateway then exits (e.g. "another instance already listening"), use the cron watchdog or keep it in the foreground instead.

### Gateway or CLI runs out of memory (OOM)

If you see **"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"** and a **"Last few GCs"** block showing the heap near ~4 GB (e.g. `4093.4 (4098.2) MB`), the Node process (gateway or CLI) hit the V8 heap limit and was killed. That can cause the gateway to exit abruptly, so the CLI then reports **1006 (gateway closed)**.

- **Raise the heap for the gateway** so it has more headroom:
  ```bash
  export NODE_OPTIONS='--max-old-space-size=8192'
  openclaw gateway run
  ```
  (8 GB; use 6144 for 6 GB if 8 is too much.) If you start the gateway via systemd or a script, set `NODE_OPTIONS` in that environment.

- **Reduce memory pressure** so the process stays under the limit:
  - In `openclaw.json`: lower `agents.defaults.bootstrapMaxChars` and `bootstrapTotalMaxChars`, and optionally `contextTokens`.
  - In the memory-hybrid plugin config: lower auto-recall token budget (e.g. `autoRecall.limit` or the token cap) so less context is loaded per turn.

- The stack trace may show **`ValueDeserializer::ReadValue`** / **`Message::Deserialize`** — that indicates a **very large message** (e.g. huge session or bootstrap) being deserialized. Trimming bootstrap files (e.g. `MEMORY.md`, identity files) and lowering the config limits above helps.

---

## Port not releasing (gateway port 18789 already in use)

When the gateway exits (crash, OOM, or `gateway stop`) the port can stay in use so the next start fails with **"Port 18789 is already in use"** or **"another gateway instance is already listening"**. Common causes and what to do:

### Why the port may not release

1. **Stale process** — The Node process didn’t exit (e.g. stuck in GC during OOM, or not handling SIGTERM). The OS keeps the socket open until the process dies.
2. **socat or other forwarder** — A **socat** (or similar) process is listening on the gateway port to forward LAN → localhost (e.g. `socat TCP-LISTEN:18789,bind=192.168.1.240,fork,reuseaddr TCP:127.0.0.1:18789`). The gateway then can’t bind. Stop the forwarder so the gateway can start; if you need LAN access, run socat **after** the gateway is up, e.g. on another port: `socat TCP-LISTEN:18790,bind=192.168.1.240,fork,reuseaddr TCP:127.0.0.1:18789`.
3. **TIME_WAIT** — After the process closes the socket, the kernel keeps the port in TIME_WAIT for 60–120 seconds so in-flight packets can finish. You can’t bind to the same port until it’s released (unless the server sets SO_REUSEADDR; that’s up to OpenClaw).
4. **Two supervisors** — Both systemd and the cron watchdog (or two manual `gateway run` invocations) can start the gateway; one may exit while the other or a child still holds the port.
5. **Lock file / “another instance”** — OpenClaw may use an internal lock and report “port in use” even when nothing is listening; stopping all gateway processes and clearing locks fixes that.

### Find what is using the port

```bash
# One of these should show the PID (or that the port is free)
ss -tlnp | grep 18789
lsof -i :18789
fuser 18789/tcp
```

If you see a PID, that process is holding the port. OpenClaw sometimes prints it explicitly, e.g. **`pid 1688 markus: /usr/bin/socat TCP-LISTEN:18789,bind=192.168.1.240,...`** — then stop that process (e.g. `kill 1688` or `kill -9 1688`). If the port appears in use but no PID is listed, it’s often TIME_WAIT (wait 1–2 minutes and try again).

### Force-release the port

1. **Stop the gateway cleanly first:**
   ```bash
   openclaw gateway stop
   ```
   Wait a few seconds.

2. **Run the force-release script** (from this repo or from `~/.openclaw/scripts/` if you copied it):
   ```bash
   ./scripts/force-release-gateway-port.sh
   ```
   It stops the systemd service (if any), finds any process on the gateway port (via `ss`, `lsof`, or `fuser`), sends SIGTERM then SIGKILL if needed, and reports whether the port is free. See [scripts/README.md](../scripts/README.md#force-release-gateway-port).

3. **Manual kill** if you don’t use the script:
   ```bash
   openclaw gateway stop
   # Replace PID with the number from ss/lsof/fuser
   kill -TERM <PID>
   sleep 3
   kill -9 <PID>   # only if still running
   ```

4. **If the port is still “in use” but no process is listed** — Likely TIME_WAIT. Wait 60–120 seconds, then run `openclaw gateway run` again. Optionally reduce TIME_WAIT (requires root): `sysctl -w net.ipv4.tcp_fin_timeout=30` (default is often 60).

### Avoid port-not-releasing in the future

- Use **one** way to run the gateway: either **systemd** (`openclaw gateway start`/`stop`) **or** the **cron watchdog** with `openclaw gateway run`, not both.
- After an OOM or crash, run the force-release script (or manual kill) before starting again.
- Give the gateway enough heap so it’s less likely to OOM and leave a stuck process: `NODE_OPTIONS='--max-old-space-size=8192'` when starting the gateway.

### WSL2 and Windows port conflict (e.g. 18789 on Windows)

On **WSL2**, Windows and Linux share localhost in a way that can cause port clashes. If you see **"another gateway instance is already listening"** or the gateway won’t start, check **Windows** as well as WSL.

**Check Windows:**

```cmd
netstat -ano | findstr 18789
```

If you see **LISTENING** with a PID (e.g. `TCP 0.0.0.0:18789 ... LISTENING 4700`), something on **Windows** is using 18789. Often that PID is **svchost.exe** — a Windows service is holding the port. Common causes: **IP Helper (iphlpsvc)** implementing a **portproxy** rule, or WSL’s localhost forwarding.

**See portproxy rules (IP Helper / netsh)** — run in an **elevated** Command Prompt or PowerShell:

```cmd
netsh interface portproxy show all
```

If 18789 appears there, it’s a **port forwarding rule** (e.g. Windows → WSL). The **IP Helper service (iphlpsvc)** is what actually listens on the port for portproxy. To see which service is behind a PID:

```powershell
tasklist /FI "PID eq 4700" /V
Get-Service | Where-Object { $_.Status -eq 'Running' -and $_.Name -match 'iphlp|winnat' }
```

**See excluded port ranges** (Hyper-V / WSL sometimes reserve blocks):

```cmd
netsh int ipv4 show excludedportrange protocol=tcp
```

If 18789 falls inside a range listed there, that’s why the port is “taken” from the system’s point of view. Restarting the **Windows NAT** driver can sometimes free ranges (run as Administrator: `net stop winnat` then `net start winnat`; WSL will be briefly affected).

**Option A: Remove the Windows portproxy rule (if 18789 is in `portproxy show all` or `netsh dump`)**

If you see a rule like `add v4tov4 listenport=18789 connectaddress=127.0.0.1 connectport=18789` (e.g. from `netsh dump | findstr 18789`), the **IP Helper service** is listening on 18789 to forward Windows → WSL. To free the port, run in an **elevated** Command Prompt (Admin):

```cmd
netsh interface portproxy delete v4tov4 listenport=18789 listenaddress=0.0.0.0 protocol=tcp
netsh interface portproxy delete v4tov4 listenport=18789 listenaddress=127.0.0.1 protocol=tcp
```

Run both; the one that matches your rule will succeed. Then run `netsh interface portproxy show all` to confirm 18789 is gone, and restart the gateway in WSL. If WSL or a script re-creates the rule after a reboot, use **Option B** (different port) instead.

**Option B: Use a different port (recommended)**

Switch the gateway to a port that Windows is not using (e.g. **18790**), and use it everywhere:

1. **WSL – systemd:** override the port in a drop-in (create `~/.config/systemd/user/openclaw-gateway.service.d/port.conf`):
   ```ini
   [Service]
   ExecStart=
   ExecStart=/home/linuxbrew/.linuxbrew/opt/node/bin/node /home/markus/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18790
   Environment=OPENCLAW_GATEWAY_PORT=18790
   ```
   Then `systemctl --user daemon-reload` and `openclaw gateway start` (or `systemctl --user start openclaw-gateway.service`).

2. **WSL – manual/cron:** start with `OPENCLAW_GATEWAY_PORT=18790 openclaw gateway run --port 18790`.

3. **CLI / agents:** set the same port when calling the gateway, e.g. in your shell profile or before commands:
   ```bash
   export OPENCLAW_GATEWAY_PORT=18790
   openclaw status -deep
   openclaw hybrid-mem verify
   ```

4. **Cron watchdog:** set `OPENCLAW_GATEWAY_PORT=18790` in the crontab or inside `~/.openclaw/scripts/gateway-watchdog-cron.sh`.

5. **Force-release script:** if you use 18790, run `OPENCLAW_GATEWAY_PORT=18790 ./scripts/force-release-gateway-port.sh` when cleaning the port.

After switching, the CLI uses the new port via `OPENCLAW_GATEWAY_PORT`; no change to `openclaw.json` is usually needed unless OpenClaw documents a gateway port setting there.

---

## Install warning: "dangerous code patterns" / "credential harvesting"

When you run `openclaw plugins install openclaw-hybrid-memory`, the OpenClaw plugin scanner may show:

```text
WARNING: Plugin "openclaw-hybrid-memory" contains dangerous code patterns: Environment variable access combined with network send - possible credential harvesting
```

This is a **false positive**. The plugin only uses your configured API keys (OpenAI, Google, or none for local providers such as Ollama and ONNX) to call the respective embedding APIs; it does not send credentials anywhere else. The scanner flags any plugin that both reads environment variables (e.g. for config) and performs network requests. You can ignore this warning and continue. To use your key from the environment, set `embedding.apiKey` in config to `"${OPENAI_API_KEY}"` (see [CONFIGURATION.md](CONFIGURATION.md)).

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| memory-hybrid disabled / "memory slot set to memory-core" | Slot not set | Set `plugins.slots.memory` to `"openclaw-hybrid-memory"` in `openclaw.json` |
| Plugin fails to load / "embedding.apiKey is required" | No OpenAI key in config | Add `embedding.apiKey` and `embedding.model` to plugin config. See [CONFIGURATION.md](CONFIGURATION.md). |
| Invalid or expired API key | Key wrong, revoked, or out of credits | First embed or `verify` will fail with 401/403. Fix the key and restart. |
| Missing env var for API key | Env not loaded in non-interactive shell | Use `"env:VAR_NAME"` SecretRef or `"${VAR}"` template — ensure the variable is exported before starting the gateway, or inline the literal key |
| Unresolvable `env:` or `file:` SecretRef in `embedding.apiKey` | Env var not exported / file missing | Plugin throws at load with a descriptive error. Export the env var before starting the gateway, or switch to a literal key |
| `"embedding.provider is 'google' but no valid key found. (SecretRef could not be resolved…)"` | `distill.apiKey` or `llm.providers.google.apiKey` is set to `env:VAR` / `file:/path` / `${VAR}` but the env var or file is missing or empty | Set the referenced env var (e.g. `export GEMINI_API_KEY=…`) or use an inline key. Both `distill.apiKey` and `llm.providers.google.apiKey` support all SecretRef formats — see [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#provider-api-keys). |
| `Cannot find module '@lancedb/lancedb'`, `better-sqlite3`, or `@sinclair/typebox` | Extension deps not installed, or OpenClaw was upgraded | Run `npm install` in the extension dir: `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm install`. See [QUICKSTART.md](QUICKSTART.md); after upgrades run post-upgrade ([MAINTENANCE.md](MAINTENANCE.md)). Full gateway stop/start. |
| Recall/capture failed after npm install | Stale module cache from SIGUSR1 reload | **Full stop then start** (`openclaw gateway stop` then `start`). Required for native modules. |
| Bootstrap file truncation | Limits too low | Increase `bootstrapMaxChars` (15000) and `bootstrapTotalMaxChars` (50000). See [CONFIGURATION.md](CONFIGURATION.md). |
| config.patch reverts API key to `${ENV_VAR}` | Gateway tool substitutes secrets | Edit config file directly for API keys |
| Prompt too large for model | Need lower cap | Set `contextTokens` to ~90% of your model's window |
| Memory files not found by search | File index stale | Ensure `sync.onSessionStart: true` and `sync.watch: true`; restart and start a new session |
| `hybrid-mem stats` still 0 after seed | Seed used wrong paths or schema | Point seed at same DB paths as plugin |
| `npm install` fails ("openclaw": "workspace:*") | devDependencies reference workspace protocols | Remove devDependencies: `node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"` then `npm install` |
| `openclaw plugin install` fails or does nothing (singular "plugin") | The correct command uses **plugins** (plural) | Use **`openclaw plugins install`** (plural). See [issue #36](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/36). |
| "plugin not found: openclaw-hybrid-memory" (blocks `plugins install`) | Config references the plugin but folder is missing | Use a standalone installer: `npx -y openclaw-hybrid-memory-install` or `curl -sSL https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh \| bash`. See [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md#when-plugin-not-found-blocks-install). |
| "duplicate plugin id detected" / two copies of memory-hybrid | Plugin exists in both global openclaw and ~/.openclaw/extensions | Use NPM only: run `./scripts/use-npm-only.sh` (from this repo) to remove the global copy. Then use `openclaw plugins install openclaw-hybrid-memory` for upgrades. See [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md#using-npm-only-recommended). |
| Could not locate bindings file (better_sqlite3.node) | Native module not built after install or rebuild was interrupted | Run `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm rebuild better-sqlite3 @lancedb/lancedb`, then `openclaw gateway stop && openclaw gateway start`. If `npm rebuild` exits non-zero (e.g. node-gyp `node_gyp_bins` ENOENT on Node 25), check whether `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists - if it does, restarting the gateway may be enough. The published package runs rebuild in `postinstall`; ensure build tools (e.g. `build-essential`, `python3`) are installed. |
| "Unrecognized keys: autoCapture, autoRecall, embedding" | Config keys placed at wrong nesting level | Move those keys under `config`. Correct structure: `plugins.entries["openclaw-hybrid-memory"]` = `{ enabled: true, config: { autoCapture, autoRecall, embedding, ... } }`. See [Config nesting](#config-nesting) below. |
| `invalid config: must NOT have additional properties` (plugin entry) | Newer OpenClaw validates plugin config using the plugin's `configSchema`; with `additionalProperties: false` any key not listed was rejected. | The plugin's `openclaw.plugin.json` now sets **`additionalProperties: true`** at the root of `configSchema` so the core accepts all config keys. The plugin still parses and validates config at runtime. If you see this error, ensure you're using a plugin version that has this change (copy `extensions/memory-hybrid/openclaw.plugin.json` from this repo to `~/.openclaw/extensions/openclaw-hybrid-memory/` or upgrade the plugin). |
| `No vector column found` / `Failed to execute query stream` | The LanceDB table was created with an embedding model of a different dimension (e.g. 1536 vs 3072). | Set `vector.autoRepair: true` in your plugin config and restart the gateway. The plugin will drop the incompatible LanceDB table and re-embed all facts from SQLite. See [CONFIGURATION.md](CONFIGURATION.md). |
| **Port 18789 already in use** / gateway won't start | Stale process, TIME_WAIT, two supervisors, or **Windows (WSL2) holding 18789** (e.g. `netstat -ano` shows LISTENING with svchost) | Run `openclaw gateway stop`, then `./scripts/force-release-gateway-port.sh`. If Windows has 18789 (WSL2), [use a different port](#wsl2-and-windows-port-conflict-eg-18789-on-windows) (e.g. 18790). Use only one supervisor (systemd or cron watchdog). |
| Agent doesn't answer chat / tools do nothing | Gateway down, plugin failed to load, or before_agent_start blocking | See [Agent not responding](#agent-not-responding--chat-or-tools-do-nothing) below. |
| Cron agents using `ollama/qwen3:*` time out or return empty responses | Qwen3 thinking mode places reply in `message.reasoning` instead of `message.content` | Fixed in plugin v2026.3.101+. Upgrade the plugin. The fix is automatic - no config change needed. |

---

## Agent not responding / chat or tools do nothing

If your local OpenClaw agent does not answer chat messages or run tools, work through these steps.

### 1. Run plugin and config checks

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem verify --fix   # apply safe fixes if offered
```

Fix any **load-blocking** issues (e.g. missing `embedding.apiKey` or `embedding.model`). If the plugin fails to load, OpenClaw may not start the agent correctly.

### 2. Ensure the gateway is running

The agent and all LLM/chat calls go through the OpenClaw gateway. If the gateway is stopped or unreachable, the agent will not respond.

```bash
openclaw gateway status    # or your OpenClaw equivalent
openclaw gateway start     # if not running
```

Do a **full restart** after any config or plugin change (required for native modules and config):

```bash
openclaw gateway stop
openclaw gateway start
```

### 3. Confirm memory slot and plugin load

In `~/.openclaw/openclaw.json` (or `OPENCLAW_HOME/openclaw.json`):

- `plugins.slots.memory` should be `"openclaw-hybrid-memory"` if you use this plugin.
- Under `plugins.entries["openclaw-hybrid-memory"]`: `enabled: true` and a valid `config` (including `embedding.apiKey` and `embedding.model` under `config`).

If the memory slot points to another plugin or the hybrid-memory plugin is disabled, the agent may still run but without this memory; wrong or broken config can prevent the plugin (and sometimes the agent) from loading.

### 4. If the agent still never responds: check before_agent_start

The plugin runs **auto-recall** in a `before_agent_start` hook. That hook calls the embedding API and, if query expansion is enabled, the LLM. If the gateway is down or those calls hang, the agent can appear stuck.

- **Temporarily disable auto-recall** to see if the agent starts answering:
  - In plugin config set `autoRecall.enabled` to `false`, then restart the gateway.
- If the agent works with auto-recall off, the problem is likely gateway/network or embedding/LLM config. Re-run `openclaw hybrid-mem verify` and fix embedding/API key issues; ensure the gateway is up and reachable (e.g. correct `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN` if you use them).

### 5. Check logs

Inspect OpenClaw (or gateway) logs for errors when you send a message. Look for:

- Plugin registration errors (e.g. "embedding.apiKey is required", config parse errors).
- Gateway/connection errors (e.g. ECONNREFUSED, timeouts).
- Errors in `before_agent_start` or from the embedding/LLM calls (e.g. 401/403, timeout).

When **nothing relevant appears** (no timeout, no errors) but the agent still doesn't respond, the turn may be **stuck** in the plugin's `before_agent_start` (e.g. waiting on the gateway/LLM for query expansion or embeddings). As of recent plugin versions:

- You should see **`memory-hybrid: auto-recall start (prompt length N)`** when a message is processed. If you see that and never see a follow-up (e.g. "injecting N memories" or "vector step timed out"), the process is hanging inside auto-recall (query expansion, embedding, or vector search). The plugin applies timeouts (query expansion: 5-25s, vector step: 30s, chatComplete: 45s); if the gateway never responds, you should see a **timeout** log after that period.
- **Temporarily disable auto-recall** (`autoRecall.enabled: false`) or **query expansion** (`queryExpansion.enabled: false`) and restart the gateway. If the agent starts responding, the hang was in that path (often gateway/LLM not responding). Re-enable after fixing the gateway or model config.

Log location depends on your OpenClaw setup (often under `~/.openclaw/` or wherever the gateway is run).

### 6. Provider cooldown / "All models failed"

If scheduled jobs or verify show **"Provider X is in cooldown"** or **"All models failed"**, one of the providers the plugin is configured to use is rate-limiting or returning errors. The plugin tries all models in the tier list in order - if all fail, the job errors.

- Run `openclaw hybrid-mem verify` and check the "Scheduled jobs" section for recent errors.
- Run `openclaw hybrid-mem verify --test-llm` to see which specific models are reachable.
- Add models from a second or third provider to `llm.nano`, `llm.default`, and `llm.heavy` so the plugin can fall back when one provider is in cooldown.
- Wait for the cooldown to clear (usually a few minutes for rate limits).

**Per-tier model config:** The plugin makes direct API calls to provider endpoints and tries each model in the list in order. To configure fallback across providers:
```json
"llm": {
  "nano":    ["google/gemini-2.5-flash-lite", "openai/gpt-4.1-nano", "anthropic/claude-haiku-4-5"],
  "default": ["google/gemini-2.5-flash",      "anthropic/claude-sonnet-4-6", "openai/gpt-4.1"],
  "heavy":   ["google/gemini-3.1-pro-preview", "anthropic/claude-opus-4-6",  "openai/o3"]
}
```
Or set `queryExpansion.model` to a single fast model (e.g. `google/gemini-2.5-flash-lite`) so query expansion does not depend on the full fallback chain. Set `queryExpansion.enabled: false` to disable query expansion entirely.

### 7. "Query expansion failed, using raw prompt" (500, timeout, or "Request was aborted")

This means the nano-tier LLM used for query expansion is failing - e.g. provider API error, missing API key, or timeout. The plugin falls back to the raw user prompt, so recall still works.

- **Fix:** Check which model is being used: `openclaw hybrid-mem verify` shows `queryExpansion.model` (or nano tier). Run `openclaw hybrid-mem verify --test-llm` to confirm it is reachable.
- Add fallback models to `llm.nano` or explicitly set `queryExpansion.model` to a reliable model.
- Set `queryExpansion.enabled: false` to disable query expansion if you want zero per-turn LLM calls.
- **Log noise:** You see at most one "query expansion failed" (or legacy "HyDE generation failed") per turn. If the auto-recall vector step times out (30s), expansion is aborted silently (only "vector step timed out, using FTS-only recall" appears).

### 8. "400/404 model not found" from verify --test-llm

The plugin calls provider APIs **directly** - no gateway allowlist is involved. If you see 400 or 404 errors:

- **404 "model does not exist"** - the model ID is wrong or your API key does not have access to that model. Run `openclaw models list --all --provider <name>` to see available model IDs for your account.
- **404 from Google embedding endpoint ("is not found for API version v1beta")** - Google's OpenAI-compatibility endpoint only supports some models (e.g. `text-embedding-004` is not available via `v1beta`). Fix: switch the embedding `model` in config to a model that is available on the OpenAI-compat endpoint, or use a different provider. The plugin detects this exact 404 pattern and **fails fast** (no retries) without reporting it to GlitchTip, so it is a config error, not a transient failure.
- **404 for MiniMax models** - if you see 404 on `minimax/*` calls and you're on an older plugin version, upgrade: a previous bug routed MiniMax requests to `api.openai.com` instead of `api.minimax.io`. Since v1.x the plugin has a built-in `minimax` handler with the correct default endpoint (no `baseURL` needed in config).
- **400 "invalid model ID"** - use `provider/model` format: `google/gemini-2.5-flash`, `openai/gpt-4.1-nano`, `anthropic/claude-haiku-4-5`, `minimax/MiniMax-M2.5`.
- **400 "unsupported parameter: temperature"** - OpenAI reasoning model (`o1`, `o3`, `o4-*`). The plugin automatically strips `temperature` for these; ensure you are running the latest plugin version.
- **401 / authentication error** - check that `llm.providers.<provider>.apiKey` is set correctly in plugin config.
- **No key configured** - verify shows `⚠️ skipped` for that model. Add the key to `llm.providers.<provider>.apiKey`.
---

## Temporarily disabling hybrid-memory for testing

To test OpenClaw **without** the hybrid-memory plugin (e.g. to isolate "invalid config" or "agent not responding" issues):

1. **Back up** your config: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak`
2. **Switch the memory slot** to the built-in memory: in `~/.openclaw/openclaw.json`, set `plugins.slots.memory` to `"memory-core"` (instead of `"openclaw-hybrid-memory"`).
3. **Remove the plugin entry** (or set `enabled: false`): delete the `plugins.entries["openclaw-hybrid-memory"]` object entirely so OpenClaw no longer loads or validates that plugin config. Leave `plugins.installs["openclaw-hybrid-memory"]` if you want to re-enable later without reinstalling.
4. **Restart the gateway:** `openclaw gateway stop && openclaw gateway start`

**Re-enabling:** Restore from backup (`cp ~/.openclaw/openclaw.json.bak ~/.openclaw/openclaw.json`) and restart the gateway. If you get `invalid config: must NOT have additional properties` again, the new OpenClaw may be validating plugin config strictly; you may need to wait for a plugin or OpenClaw release that aligns the config schema, or try re-adding only the minimal required keys (`embedding`, `enabled`) under `config` and see if the core accepts that.

---

## Config nesting

If you see an error like **"Unrecognized keys: autoCapture, autoRecall, embedding"**, the plugin config is at the wrong nesting level.

**Wrong** (keys directly under the plugin entry):

```json
"openclaw-hybrid-memory": {
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "embedding": { "apiKey": "...", "model": "text-embedding-3-small" }
}
```

**Correct** (keys nested under `config`):

```json
"openclaw-hybrid-memory": {
  "enabled": true,
  "config": {
    "autoCapture": true,
    "autoRecall": true,
    "embedding": { "apiKey": "...", "model": "text-embedding-3-small" }
  }
}
```

Move `autoCapture`, `autoRecall`, `embedding`, and any other plugin settings into `plugins.entries["openclaw-hybrid-memory"].config`. See [CONFIGURATION.md](CONFIGURATION.md).

---

## API key detection and behaviour

### At config load

If `embedding.apiKey` is missing or not a string, the plugin throws and does not register. You must supply a key.

`env:VAR_NAME` and `file:PATH` SecretRef formats are resolved at config load time. If the referenced variable or file is unset/missing, the plugin throws a descriptive error (e.g. `embedding.apiKey references environment variable 'OPENAI_API_KEY' which could not be resolved`). For non-OpenAI providers where `embedding.apiKey` is an optional fallback, an unresolvable SecretRef logs a warning instead of throwing.

### At runtime

Embeddings are used for vector search, auto-recall, store, consolidate, and find-duplicates. If the key is invalid or the API fails (401, 403, network):

- Those operations log a warning and skip or return empty
- Auto-recall falls back to FTS-only
- Store skips the vector write
- SQLite-only paths (lookup, FTS search, prune, stats) still work

### Detection

Run `openclaw hybrid-mem verify` - it checks for a non-placeholder key and calls the embedding API once. If invalid, verify reports "Embedding API: FAIL".

### Failover

The plugin does **not** support automatic failover to another provider. All embeddings and LLM calls use the configured OpenAI key only.

---

## Related docs

- [FAQ.md](FAQ.md) - Quick answers to common questions
- [QUICKSTART.md](QUICKSTART.md) - Installation
- [CONFIGURATION.md](CONFIGURATION.md) - Full config reference
- [OPERATIONS.md](OPERATIONS.md) - Background jobs, scripts, upgrades
- [CLI-REFERENCE.md](CLI-REFERENCE.md) - All CLI commands
- [CREDENTIALS.md](CREDENTIALS.md) - Credential vault troubleshooting
- [WAL-CRASH-RESILIENCE.md](WAL-CRASH-RESILIENCE.md) - Write-ahead log design
