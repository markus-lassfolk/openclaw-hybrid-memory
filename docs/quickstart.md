# Quickstart

This is the shortest path to a working Hybrid Memory setup.

## Who this is for

- Personal assistant usage
- Local-first default setup
- First successful run in a few minutes

## 1. Install

```bash
openclaw plugins install openclaw-hybrid-memory
```

## 2. Apply recommended defaults

```bash
openclaw hybrid-mem install
```

## 3. Configure embeddings (required)

Set `embedding.provider` and `embedding.model` in `~/.openclaw/openclaw.json`.

Examples:
- OpenAI: `text-embedding-3-small`
- Ollama: `nomic-embed-text`
- ONNX: `all-MiniLM-L6-v2`
- Google: `gemini-embedding-001`

## 4. Restart OpenClaw

```bash
openclaw gateway stop
openclaw gateway start
```

## 5. Verify

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem stats
```

Success target: `verify` ends with `All checks passed.` and `stats` shows memory counts.

## First useful commands

```bash
openclaw hybrid-mem search "my decision about backups"
openclaw hybrid-mem search "project preferences"
openclaw hybrid-mem verify --fix
```

## Next docs

- Trust model and deletion: [trust-and-privacy.md](trust-and-privacy.md)
- Production operations: [operations.md](operations.md)
- Advanced features: [advanced-capabilities.md](advanced-capabilities.md)
- Full CLI details: [CLI-REFERENCE.md](CLI-REFERENCE.md)
