# "tool_use ids without tool_result" error

## What you see

OpenClaw (or the Claude API) may reject a request with:

```text
LLM request rejected: messages.N: `tool_use` ids were found without `tool_result` blocks
immediately after: process..., subagents.... Each `tool_use` block must have a corresponding
`tool_result` block in the next...
```

## Cause

The Claude/Anthropic API requires that **every assistant message containing `tool_use` blocks is immediately followed by a tool-role message** that has a `tool_result` block for each of those `tool_use` ids. If that ordering is broken, the API rejects the request.

Common ways this happens:

1. **Context-window trimming** – When the conversation is trimmed to fit the context window, the code may keep an assistant message that includes `tool_use` (e.g. from `process` or `subagents` tools) but drop the following message(s) that contained the `tool_result`s.
2. **Session replay** – Loading from session JSONL where an assistant turn with tool calls was persisted but the corresponding tool-result turn was not (e.g. crash or truncation).
3. **Message building bugs** – The code that builds the `messages` array for the API sometimes omits or reorders tool-result messages.

The fix belongs in the place that **builds or trims the `messages` array** before sending to the API (typically OpenClaw core), not in this plugin.

## Fix options

### 1. Sanitize before send (recommended)

Run the provided sanitizer over `messages` immediately before calling the Claude API. It appends synthetic `tool_result` blocks for any orphan `tool_use` ids so the request is valid.

From OpenClaw (or any code that has the messages array):

```ts
import { sanitizeMessagesForClaude } from "openclaw-hybrid-memory";

const safeMessages = sanitizeMessagesForClaude(messages);
// send safeMessages to the API
```

The sanitizer inserts placeholder tool results (`"[Output omitted or truncated.]"`) only for ids that are missing a `tool_result` in the next message. It does not remove or reorder existing messages.

### 2. Trim at safe boundaries

If you trim the conversation for context length, never cut in the middle of a turn. When trimming from the start (or dropping middle messages), ensure you never leave an assistant message that has `tool_use` blocks without the **immediately following** tool-role message(s). Either:

- Remove the assistant message as well (trim one more message), or
- Use `sanitizeMessagesForClaude()` after trimming so any orphan `tool_use` gets a synthetic `tool_result`.

## Exported API

- **`sanitizeMessagesForClaude(messages)`** – Returns a new array if it had to insert or extend tool messages; otherwise returns the same array. Message objects are not mutated; only new elements or new wrapper objects are added.
- **`MessageLike`** – Type for message-like objects (`role`, optional `content` as string or array of blocks) for use in TypeScript.

Defined in `extensions/memory-hybrid/utils/sanitize-messages.ts` and re-exported from the plugin entrypoint.
