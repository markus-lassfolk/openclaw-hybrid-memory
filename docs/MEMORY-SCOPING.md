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

## Migration

Existing facts get `scope = 'global'` and `scope_target = NULL` automatically. No data migration required.

## Inspiration

[engram-memory](https://github.com/engramhq/engram-memory) — Scoping: global, agent, private, shared.
