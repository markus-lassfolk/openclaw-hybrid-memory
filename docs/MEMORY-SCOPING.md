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

### memory_recall tool

Pass `userId`, `agentId`, or `sessionId` to restrict results to global + matching scopes:

```json
{
  "query": "preferences",
  "userId": "alice"
}
```

Returns: global memories + user-private memories for alice.

When no filter is provided, all memories are returned (backward compatible).

### CLI search

```bash
openclaw hybrid-mem search "preferences" --user-id alice
openclaw hybrid-mem search "blockers" --agent-id support-bot
openclaw hybrid-mem search "notes" --session-id sess-xyz
```

## Auto-Recall Scope Filter

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

## Migration

Existing facts get `scope = 'global'` and `scope_target = NULL` automatically. No data migration required.

## Inspiration

[engram-memory](https://github.com/engramhq/engram-memory) — Scoping: global, agent, private, shared.
