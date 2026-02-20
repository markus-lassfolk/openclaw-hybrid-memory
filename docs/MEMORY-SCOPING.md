---
layout: default
title: Memory Scoping (FR-006)
parent: Features
nav_order: 13
---
# Memory Scoping (FR-006)

**Explicit Memory Scoping** lets you control which memories are visible to whom in multi-agent or shared environments (e.g. Discord, Slack). Personal facts like "My dog's name is Rex" can stay private to a user; company policies can be global.

## Scope Types

| Scope | Description | Use Case |
|-------|-------------|----------|
| **Global** | Available to all agents/sessions | World facts, company policies, shared knowledge |
| **User** | Only when talking to a specific user | "User prefers dark mode", personal preferences |
| **Agent** | Only by this agent instance/persona | Internal state, agent-specific rules |
| **Session** | Ephemeral, cleared on session end (unless promoted) | Temporary context, working notes |

## Storing with Scope

### memory_store tool

```json
{
  "text": "User prefers dark mode",
  "scope": "user",
  "scopeTarget": "alice"
}
```

- **scope** (default: `global`): `global`, `user`, `agent`, or `session`
- **scopeTarget**: Required when scope is `user`, `agent`, or `session` — the userId, agentId, or sessionId

### CLI

```bash
# Global (default)
openclaw hybrid-mem store --text "Company policy: use TypeScript"

# User-private
openclaw hybrid-mem store --text "User prefers dark mode" --scope user --scope-target alice

# Session-scoped (ephemeral)
openclaw hybrid-mem store --text "Current task: refactor auth" --scope session --scope-target sess-xyz
```

## Recall with Scope Filter

> **⚠️ SECURITY WARNING**
>
> The `userId`, `agentId`, and `sessionId` parameters in `memory_recall` are **caller-controlled** and should **NOT** be trusted in multi-tenant environments. An attacker can instruct an agent to call `memory_recall` with another user's identifier to access their private memories.
>
> **Recommended approach for production:**
> - Derive scope filters from **trusted runtime identity** (authenticated user/agent/session context)
> - Use `autoRecall.scopeFilter` in config (set from integration layer with verified identity)
> - **Do not** expose `userId`/`agentId`/`sessionId` parameters directly to end users
> - For CLI usage, validate that the caller has permission to access the requested scope
>
> See "Secure Multi-Tenant Setup" section below for implementation guidance.

### memory_recall tool (Development/Testing Only)

Pass `userId`, `agentId`, or `sessionId` to restrict results to global + matching scopes:

```json
{
  "query": "preferences",
  "userId": "alice"
}
```

Returns: global memories + user-private memories for alice.

When no filter is provided, all memories are returned (backward compatible).

**Note:** In production multi-tenant environments, these parameters should be removed or validated against the authenticated user's identity to prevent cross-tenant data leakage.

### CLI search

```bash
openclaw hybrid-mem search "preferences" --user-id alice
openclaw hybrid-mem search "blockers" --agent-id support-bot
openclaw hybrid-mem search "notes" --session-id sess-xyz
```

## Auto-Recall Scope Filter (Recommended for Production)

Configure `autoRecall.scopeFilter` in plugin config to restrict injected memories per context:

```json
{
  "autoRecall": {
    "enabled": true,
    "scopeFilter": {
      "userId": "${CURRENT_USER_ID}",
      "agentId": "support-bot"
    }
  }
}
```

When set, auto-recall injects only: global + user-private for userId + agent-specific for agentId. Integrations (e.g. Discord) can set these from runtime context.

**This is the secure approach:** The integration layer (Discord bot, Slack app, etc.) sets the scope filter based on the authenticated user's identity, not on user-provided input.

## Session-Scoped Cleanup

Session-scoped memories are ephemeral. When a session ends, prune them:

```bash
openclaw hybrid-mem scope prune-session sess-xyz
```

## Promote Session → Durable

Promote a session-scoped memory to global or agent scope before session end so it persists:

### memory_promote tool

```json
{
  "memoryId": "abc-123",
  "scope": "global"
}
```

Or promote to agent scope:

```json
{
  "memoryId": "abc-123",
  "scope": "agent",
  "scopeTarget": "support-bot"
}
```

### CLI

```bash
openclaw hybrid-mem scope promote --id abc-123 --scope global
openclaw hybrid-mem scope promote --id abc-123 --scope agent --scope-target support-bot
```

## Secure Multi-Tenant Setup

For production deployments with multiple users/tenants, follow these guidelines to prevent cross-tenant data leakage:

### 1. Use Config-Based Scope Filtering

**Recommended:** Set `autoRecall.scopeFilter` in your integration layer based on authenticated identity:

```typescript
// Example: Discord integration
const userIdentity = await verifyDiscordUser(message.author.id);

const config = {
  autoRecall: {
    enabled: true,
    scopeFilter: {
      userId: userIdentity.id,  // From authenticated session
      agentId: "discord-bot"
    }
  }
};
```

### 2. Remove or Validate Tool Parameters

**Option A: Remove parameters** (most secure)

Remove `userId`, `agentId`, `sessionId` from `memory_recall` tool definition and always use config-based filtering.

**Option B: Validate parameters** (if needed for admin/debug)

```typescript
// Validate that caller has permission to access requested scope
if (params.userId && params.userId !== authenticatedUser.id) {
  if (!authenticatedUser.isAdmin) {
    throw new Error("Unauthorized: Cannot access other user's memories");
  }
}
```

### 3. CLI Access Control

For CLI commands like `hybrid-mem search --user-id alice`, implement access control:

- Require authentication before allowing scope-filtered queries
- Log all cross-user memory access for audit trails
- Restrict to admin users or implement permission checks

### 4. Integration Layer Responsibilities

Your integration (Discord bot, Slack app, web API) should:

1. **Authenticate** the user before any memory operations
2. **Set scope filters** based on verified identity, not user input
3. **Never** pass user-provided `userId`/`agentId`/`sessionId` directly to memory tools
4. **Validate** that memory store operations use the authenticated user's scope

### Example: Secure Discord Integration

```typescript
// ❌ INSECURE - Don't do this
async function handleUserCommand(message: string, userId: string) {
  return await memoryRecall({ query: message, userId });  // userId from user input!
}

// ✅ SECURE - Do this
async function handleUserCommand(message: string, authenticatedSession: Session) {
  // Scope filter comes from verified session, not user input
  const config = {
    autoRecall: {
      scopeFilter: {
        userId: authenticatedSession.verifiedUserId,
        sessionId: authenticatedSession.id
      }
    }
  };
  
  // Tool calls don't include userId parameter
  return await memoryRecall({ query: message });
}
```

## Multi-Agent Configuration

**Multi-agent scoping** enables specialist agents (Forge, Scholar, Hearth) to build domain expertise while maintaining shared global knowledge with the orchestrator (Maeve).

### Configuration

Add `multiAgent` section to plugin config:

```json
{
  "multiAgent": {
    "orchestratorId": "main",
    "defaultStoreScope": "auto"
  }
}
```

**Options:**

- **orchestratorId** (default: `"main"`): Agent ID of the main orchestrator
  - The orchestrator sees all memories (no scope filter)
  - All other agents are considered "specialists"

- **defaultStoreScope** (default: `"global"`):
  - `"global"`: All agents store to global scope (existing behavior, backward compatible)
  - `"agent"`: All agents store to agent-specific scope (full isolation except explicit global stores)
  - `"auto"`: **Recommended** — Orchestrator stores global, specialists store agent-scoped

### Recommended Setup: "auto" Mode

```json
{
  "multiAgent": {
    "orchestratorId": "main",
    "defaultStoreScope": "auto"
  }
}
```

**Behavior:**

| Agent | Stores | Sees (auto-recall) | Rationale |
|-------|--------|-------------------|-----------|
| **Maeve (orchestrator)** | `scope='global'` | All memories | Needs full context for coordination |
| **Forge (coding)** | `scope='agent'` `target='forge'` | Global + Forge | Builds code expertise privately |
| **Scholar (research)** | `scope='agent'` `target='scholar'` | Global + Scholar | Accumulates research methods |
| **Hearth (HA)** | `scope='agent'` `target='hearth'` | Global + Hearth | Home Assistant domain knowledge |

**Explicit overrides:** Any agent can still explicitly store with `scope: "global"` to share knowledge.

### Examples

#### Store domain expertise (automatic with "auto" mode)

```typescript
// Forge (specialist agent) — automatically scoped to agent='forge'
await memory_store({
  text: "Always use Vitest for testing in this codebase",
  category: "technical"
});
// Stored with: scope='agent', scopeTarget='forge'
```

#### Store shared knowledge explicitly

```typescript
// Any agent — explicitly mark as global
await memory_store({
  text: "Markus prefers terse technical responses",
  scope: "global"
});
// Stored with: scope='global' — visible to all agents
```

#### Cross-agent queries

```typescript
// Maeve (orchestrator) can query Hearth's domain knowledge
await memory_recall({
  query: "NIBE heat pump configuration",
  agentId: "hearth"  // Explicitly query Hearth's scope
});
```

### Runtime Agent Detection

The plugin automatically detects the current agent ID from the `before_agent_start` event payload:

```typescript
api.on("before_agent_start", (event) => {
  const agentId = event.agentId || event.session?.agentId || "main";
  // Used for auto-scoping stores and filtering auto-recall
});
```

**Fallback chain:**
1. `event.agentId` (direct property)
2. `event.session?.agentId` (session context)
3. `currentAgentId` (cached from previous event)
4. `multiAgent.orchestratorId` (config default)

**Logging:** When agent detection fails or returns `null`, a warning is logged.

### Procedures (Learned Skills) Scoping

Procedures (learned tool sequences) are also scoped by agent:

```typescript
// Forge learns a git commit procedure
// Automatically scoped to agent='forge'
upsertProcedure({
  taskPattern: "Commit changes with conventional message",
  recipeJson: "[...]",
  procedureType: "positive",
  scope: "agent",
  scopeTarget: "forge"
});

// Hearth won't see Forge's procedures in auto-recall
// Maeve (orchestrator) sees all procedures for coordination
```

**Tool usage:** `memory_recall_procedures` respects scoping:

```typescript
// Defaults to current agent scope
await memory_recall_procedures({ taskDescription: "commit code" });

// Explicit cross-agent query
await memory_recall_procedures({
  taskDescription: "Home Assistant automation",
  agentId: "hearth"
});
```

### Testing Multi-Agent Setup

**Test scope isolation:**

```bash
# Store as Forge (via session or config)
openclaw sessions send --to forge --message 'Remember: Always run npm test before commit'

# Query as Hearth (should NOT see Forge's memory)
openclaw hybrid-mem search "npm test" --agent-id hearth
# Expected: 0 results ✅

# Query as Forge (should see it)
openclaw hybrid-mem search "npm test" --agent-id forge
# Expected: 1 result ✅
```

**Test global sharing:**

```bash
# Store global fact
openclaw hybrid-mem store --text "Markus prefers dark mode" --scope global

# Query from any agent (should all see it)
openclaw hybrid-mem search "dark mode" --agent-id forge
openclaw hybrid-mem search "dark mode" --agent-id hearth
# Both return 1 result ✅
```

### Troubleshooting

**Symptom:** Agent memories not isolated (all agents see everything)

**Check:**
1. `multiAgent.defaultStoreScope` is set to `"auto"` or `"agent"` (not `"global"`)
2. Agent ID detection is working (check logs for warnings)
3. OpenClaw passes `agentId` in `before_agent_start` event payload

**Symptom:** Warning: "Agent detection failed - no agentId in event payload"

**Fix:**
- Verify OpenClaw version supports multi-agent (check release notes)
- Check that `event.agentId` or `event.session.agentId` is populated
- Temporarily set `multiAgent.orchestratorId` to match the agent having issues

**Symptom:** Specialist agent sees orchestrator's memories but not own

**Check:**
- `currentAgentId` might be stuck on `"main"` — restart OpenClaw gateway
- Agent naming mismatch (e.g., config says `"forge"` but session uses `"Forge"`) — IDs are case-sensitive

## Migration

Existing facts get `scope = 'global'` and `scope_target = NULL` automatically. No data migration required.

## Inspiration

[engram-memory](https://github.com/engramhq/engram-memory) — Scoping: global, agent, private, shared.
