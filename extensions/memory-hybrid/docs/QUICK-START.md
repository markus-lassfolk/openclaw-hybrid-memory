# Quick Start Guide

Get started with OpenClaw Hybrid Memory in under 5 minutes.

## TL;DR - Fastest Path

```bash
# 1. Run interactive setup (guides you through provider selection)
openclaw hybrid-mem setup --interactive

# 2. Store your first memory
openclaw hybrid-mem store "I prefer TypeScript for large projects"

# 3. Search your memory
openclaw hybrid-mem search "programming language preferences"
```

**Done!** Your memory system is working. Jump to [Common Workflows](#common-workflows) to learn more.

---

## What is Hybrid Memory?

A two-tier memory system for your AI assistant:

- **SQLite + Full-Text Search (FTS5)** - Fast, exact keyword matching, zero API costs
- **LanceDB + Embeddings** - Semantic search that understands meaning and context

The system automatically merges results from both to give you the best of both worlds.

## Choose Your Path

### Path 1: Local-Only (No API Key Needed) ⭐ Recommended

Best for: Privacy, zero costs, getting started quickly

```bash
# Option A: Use Ollama (better quality)
# 1. Install Ollama from https://ollama.ai
# 2. Start Ollama
ollama serve

# 3. Pull embedding model
ollama pull nomic-embed-text

# 4. Configure plugin
openclaw hybrid-mem config-set embedding.provider ollama
openclaw hybrid-mem config-set embedding.model nomic-embed-text
```

```bash
# Option B: Use ONNX (lighter, no dependencies)
npm install --prefix ~/.openclaw/extensions/openclaw-hybrid-memory onnxruntime-node
openclaw hybrid-mem config-set embedding.provider onnx
openclaw hybrid-mem config-set embedding.model all-MiniLM-L6-v2
```

### Path 2: Cloud-Based (OpenAI)

Best for: Highest quality embeddings, already have OpenAI API key

```bash
# Set your API key
openclaw hybrid-mem config-set embedding.apiKey sk-proj-...

# Set provider
openclaw hybrid-mem config-set embedding.provider openai
openclaw hybrid-mem config-set embedding.model text-embedding-3-small
```

---

## Verify Your Setup

```bash
# Check if everything is working
openclaw hybrid-mem verify

# Or run full diagnostics
openclaw hybrid-mem doctor

# Check provider status
openclaw hybrid-mem providers

# View current config
openclaw hybrid-mem config
```

---

## Your First 5 Minutes

### 1. Try the Interactive Demo (2 min)

```bash
openclaw hybrid-mem demo
```

Shows you semantic search, full-text search, and categories with sample data.

### 2. Store Some Facts (1 min)

```bash
# Store individual facts
openclaw hybrid-mem store "Python is great for data science"
openclaw hybrid-mem store "React is my go-to for web UIs" --category technology

# Or ingest existing files
openclaw hybrid-mem ingest-files --paths README.md docs/
```

### 3. Search Your Memory (1 min)

```bash
# Semantic search (understands meaning)
openclaw hybrid-mem search "web development frameworks"

# List recent facts
openclaw hybrid-mem list --limit 10

# View stats
openclaw hybrid-mem stats
```

### 4. Check Health (30 sec)

```bash
# Quick health check with traffic lights 🟢🟡🔴
openclaw hybrid-mem health
```

### 5. Learn More Commands (30 sec)

```bash
# See example commands for common tasks
openclaw hybrid-mem examples basics
openclaw hybrid-mem examples setup
openclaw hybrid-mem examples maintenance
```

---

## Common Workflows

### Daily Usage

```bash
# Store a new fact
openclaw hybrid-mem store "Today I learned about GraphQL subscriptions"

# Search for something
openclaw hybrid-mem search "API design patterns"

# View recent memories
openclaw hybrid-mem list --limit 20
```

### Weekly Maintenance

```bash
# Run all maintenance tasks at once
openclaw hybrid-mem run-all

# Or run individually:
openclaw hybrid-mem tier-compact    # Organize facts by age/importance
openclaw hybrid-mem prune           # Remove expired facts
openclaw hybrid-mem vectordb-optimize  # Reclaim disk space
```

### Extract from Session Logs

```bash
# Preview what would be extracted (safe)
openclaw hybrid-mem distill --days 7 --dry-run

# Actually extract facts
openclaw hybrid-mem distill --days 7
```

### Backup Your Memory

```bash
# Create a backup
openclaw hybrid-mem backup

# Verify database integrity
openclaw hybrid-mem backup verify

# Backup retention + health audit: completed/retained/stale counts, bytes, last success/failure
openclaw hybrid-mem backup status

# Deterministically clean up stale/partial artifacts and enforce retention
openclaw hybrid-mem backup prune
```

Every successful `backup` run automatically prunes older completed snapshots per
`maintenance.backup.retentionCount` / `retentionAgeDays` (default: keep the 7 newest, or any
snapshot newer than 30 days — the single newest snapshot is always kept even if it's the only
one and has aged out). Backups are written atomically: a crash mid-backup never leaves a
half-written directory that looks like a completed snapshot. See
[`../../../docs/OPERATIONS.md`](../../../docs/OPERATIONS.md) for the full retention/health-alerting
reference.

---

## Troubleshooting

### Provider Not Working?

```bash
# Check which providers are available
openclaw hybrid-mem providers

# Run diagnostics
openclaw hybrid-mem doctor

# Run deep FTS trigger/index probe
openclaw hybrid-mem doctor --deep

# Rebuild FTS index if doctor reports population drift
openclaw hybrid-mem doctor --fix

# For Ollama: Make sure it's running
ollama serve

# For OpenAI: Check your API key
openclaw hybrid-mem config
```

### Databases Out of Sync?

```bash
# Check sync status
openclaw hybrid-mem verify --reconcile

# Fix issues
openclaw hybrid-mem verify --reconcile --fix
```

### Need Help?

```bash
# Full diagnostics
openclaw hybrid-mem doctor

# View configuration
openclaw hybrid-mem config

# See examples for specific tasks
openclaw hybrid-mem examples troubleshooting

# Check command help
openclaw hybrid-mem --help
openclaw hybrid-mem <command> --help
```

---

## Next Steps

Once you're comfortable with the basics:

1. **Set up automatic extraction**: Configure `distill` to run via cron
2. **Explore advanced features**: Reflection, classification, graph retrieval
3. **Integrate with your workflow**: Use API tools in your prompts
4. **Set up backups**: Automate `backup` command

### Learn More

- **Examples**: `openclaw hybrid-mem examples <category>`
- **Full CLI Reference**: See `../../../docs/CLI-REFERENCE.md`
- **Configuration Guide**: See `../../../docs/CONFIGURATION.md`
- **Architecture**: See `../../../docs/ARCHITECTURE.md`

---

## Quick Reference Card

| Task | Command |
|------|---------|
| Setup wizard | `openclaw hybrid-mem setup --interactive` |
| Store a fact | `openclaw hybrid-mem store "text"` |
| Search memory | `openclaw hybrid-mem search "query"` |
| List facts | `openclaw hybrid-mem list --limit 10` |
| View stats | `openclaw hybrid-mem stats` |
| Health check | `openclaw hybrid-mem health` |
| Run diagnostics | `openclaw hybrid-mem doctor` |
| Deep FTS probe | `openclaw hybrid-mem doctor --deep` |
| Check providers | `openclaw hybrid-mem providers` |
| Try demo | `openclaw hybrid-mem demo` |
| See examples | `openclaw hybrid-mem examples basics` |
| Run maintenance | `openclaw hybrid-mem run-all` |
| Backup memory | `openclaw hybrid-mem backup` |
| View config | `openclaw hybrid-mem config` |
| Get help | `openclaw hybrid-mem --help` |

---

## Don't Want to Read Docs?

We get it. Here's the absolute minimum:

```bash
# Do these 3 things:
openclaw hybrid-mem setup --interactive  # Answer a few questions
openclaw hybrid-mem demo                 # See it work
openclaw hybrid-mem examples basics      # Learn by example
```

That's it. The rest you'll learn as you go. 🚀
