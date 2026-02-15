# Prompt 1: Create the Plugin Files

Paste this into your AI assistant:

```
I need you to create a OpenClaw memory-hybrid plugin. Create the following
4 files in my OpenClaw extensions directory:

- Windows: %APPDATA%\npm\node_modules\openclaw\extensions\memory-hybrid\
- Linux: /usr/lib/node_modules/openclaw/extensions/memory-hybrid/

Create the directory if it doesn't exist, then create these files exactly
as shown.

File 1 — package.json:

{
  "name": "@openclaw/memory-hybrid",
  "version": "2026.1.24",
  "type": "module",
  "description": "Hybrid memory plugin: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  "dependencies": {
    "@lancedb/lancedb": "^0.23.0",
    "@sinclair/typebox": "0.34.47",
    "better-sqlite3": "^11.0.0",
    "openai": "^6.16.0"
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}

File 2 — openclaw.plugin.json:

{
  "id": "memory-hybrid",
  "kind": "memory",
  "uiHints": {
    "embedding.apiKey": {
      "label": "OpenAI API Key",
      "sensitive": true,
      "placeholder": "sk-proj-...",
      "help": "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})"
    },
    "embedding.model": {
      "label": "Embedding Model",
      "placeholder": "text-embedding-3-small",
      "help": "OpenAI embedding model to use"
    },
    "lanceDbPath": {
      "label": "LanceDB Path",
      "placeholder": "~/.openclaw/memory/lancedb",
      "advanced": true
    },
    "sqlitePath": {
      "label": "SQLite Path",
      "placeholder": "~/.openclaw/memory/facts.db",
      "advanced": true
    },
    "autoCapture": {
      "label": "Auto-Capture",
      "help": "Automatically capture important information from conversations"
    },
    "autoRecall": {
      "label": "Auto-Recall",
      "help": "Automatically inject relevant memories into context"
    }
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "embedding": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "apiKey": { "type": "string" },
          "model": {
            "type": "string",
            "enum": ["text-embedding-3-small", "text-embedding-3-large"]
          }
        },
        "required": ["apiKey"]
      },
      "lanceDbPath": { "type": "string" },
      "sqlitePath": { "type": "string" },
      "autoCapture": { "type": "boolean" },
      "autoRecall": { "type": "boolean" }
    },
    "required": ["embedding"]
  }
}

File 3 — config.ts:
(Copy from extensions/memory-hybrid/config.ts in this repo.)

File 4 — index.ts:
(Copy from extensions/memory-hybrid/index.ts in this repo.)

Create all 4 files exactly as shown. Do not modify the code.
```
