---
layout: default
title: Examples & Recipes
parent: Getting Started
nav_order: 4
---
# Examples & Recipes

Real-world patterns for getting the most out of hybrid memory.

---

## Setting up memory for a coding project

### Bootstrap files

**MEMORY.md** — keep it lean, pointing to detail files:

```markdown
# Long-Term Memory Index

## 🟢 Active Context
- [[memory/projects/my-saas-app.md]]
- [[memory/people/owner.md]]

## 🛠 Technical Knowledge
- **Stack:** [[memory/technical/my-saas-stack.md]] — Next.js, Postgres, Vercel
- **API Keys:** [[memory/technical/api-keys.md]] — locations and rotation notes

## ⚖️ Decisions Log
- [[memory/decisions/2026-02.md]]
```

**memory/projects/my-saas-app.md** — project state:

```markdown
# My SaaS App

## Status
🟢 Active — MVP in progress

## Stack
- Frontend: Next.js 15 + Tailwind
- Backend: tRPC + Drizzle ORM
- Database: PostgreSQL 16 on Supabase
- Hosting: Vercel (frontend), Railway (API)

## Current Sprint
- [ ] User authentication (OAuth + email)
- [ ] Dashboard layout
- [x] Database schema v1

## Architecture Decisions
- Chose tRPC over REST — see decisions/2026-02.md
- Using Drizzle over Prisma for type safety
```

**What happens:** The agent gets `MEMORY.md` every turn (knows the project exists and its stack). When you ask about the project, memorySearch finds `my-saas-app.md` and loads the full context. Decisions are auto-captured by the plugin and also logged to `decisions/2026-02.md`.

---

## Setting up memory for home automation

### Structured facts vs files

**Use memory files for:** reference data (device lists, IP addresses, configuration guides).
**Use memory_store for:** small facts and preferences ("I prefer automations to run at sunset", "Zigbee coordinator is on /dev/ttyUSB0").

**memory/technical/home-assistant.md:**

```markdown
# Home Assistant

## Access
- URL: http://192.168.1.100:8123
- API: Long-lived token stored in credential vault

## Devices
| Device | Type | Location | Protocol |
|--------|------|----------|----------|
| Living room lights | Zigbee | Living room | Z2M |
| Thermostat | WiFi | Hallway | Native |
| Motion sensor | Zigbee | Entrance | Z2M |

## Integrations
- Zigbee2MQTT on /dev/ttyUSB0
- MQTT broker: Mosquitto on port 1883
- Node-RED for complex automations
```

**Tags in action:** Facts auto-tagged with `homeassistant`, `zigbee`, `z-wave`, etc. can be filtered:

```bash
# Find all home automation facts
openclaw hybrid-mem search "automation" --tag homeassistant

# Lookup specific device info
openclaw hybrid-mem lookup "home assistant" --key "zigbee"
```

---

## Tuning auto-recall for better results

### Problem: too many irrelevant memories injected

Increase `minScore` and decrease `limit`:

```json
{
  "autoRecall": {
    "enabled": true,
    "minScore": 0.5,
    "limit": 3,
    "maxTokens": 400
  }
}
```

### Problem: important facts not recalled

Lower `minScore`, increase `limit`, enable entity lookup:

```json
{
  "autoRecall": {
    "enabled": true,
    "minScore": 0.2,
    "limit": 8,
    "maxTokens": 1200,
    "entityLookup": {
      "enabled": true,
      "entities": ["user", "owner"],
      "maxFactsPerEntity": 3
    }
  }
}
```

### Problem: context too full from memories

Use shorter injection format and summaries:

```json
{
  "autoRecall": {
    "enabled": true,
    "injectionFormat": "short",
    "maxTokens": 500,
    "useSummaryInInjection": true,
    "summaryThreshold": 200
  }
}
```

### Problem: old stable facts outranked by recent noisy ones

Boost long-lived facts:

```json
{
  "autoRecall": {
    "preferLongTerm": true,
    "useImportanceRecency": true
  }
}
```

### Progressive disclosure (FR-009): agent-driven memory retrieval

Inject a lightweight memory index instead of full texts; the agent uses `memory_recall` to fetch only what it needs. Saves tokens and scales to large memory stores:

```json
{
  "autoRecall": {
    "injectionFormat": "progressive",
    "progressiveMaxCandidates": 15,
    "progressiveIndexMaxTokens": 300
  }
}
```

Optional: pin frequently used or permanent facts in full, rest as index:

```json
{
  "autoRecall": {
    "injectionFormat": "progressive_hybrid",
    "progressivePinnedRecallCount": 3,
    "progressiveGroupByCategory": true
  }
}
```

---

## Using tags effectively

### Auto-tagging

Tags are inferred automatically from fact content. The plugin recognizes common topics:

| Domain | Tags detected |
|--------|--------------|
| Smart home | `homeassistant`, `zigbee`, `z-wave`, `mqtt`, `nibe` |
| Auth | `auth`, `oauth`, `jwt` |
| Infrastructure | `docker`, `kubernetes`, `postgres`, `sqlite`, `lancedb` |
| Tools | `openclaw`, `api`, `git` |

### Manual tags

When auto-tagging isn't enough, add explicit tags:

```bash
# CLI
openclaw hybrid-mem store --text "NIBE F1245 uses Modbus TCP on port 502" --tags "nibe,modbus,hvac"

# Agent tool
memory_store(text: "...", tags: ["nibe", "modbus", "hvac"])
```

### Tag-filtered queries

```bash
# Find all Zigbee-related facts
openclaw hybrid-mem search "device pairing" --tag zigbee

# Lookup user preferences tagged with auth
openclaw hybrid-mem lookup user --tag auth

# Agent: recall with tag filter
memory_recall(query: "device settings", tag: "homeassistant")
```

---

## When to use memory_store vs writing a memory file

| Scenario | Use `memory_store` | Use a memory file |
|----------|-------------------|-------------------|
| Small isolated fact | "User's timezone is CET" | |
| Preference | "I prefer bullet points over paragraphs" | |
| Decision with rationale | | `memory/decisions/2026-02.md` |
| Project roadmap | | `memory/projects/project.md` |
| API reference (multiple endpoints) | | `memory/technical/api-name.md` |
| Device list | | `memory/technical/devices.md` |
| Person profile | | `memory/people/name.md` |
| Quick note to remember | "Meeting with John next Tuesday" | |
| Configuration reference | | `memory/technical/config.md` |

**Rule of thumb:** If it's a single fact or preference → `memory_store`. If it's structured reference data or something that grows over time → memory file.

---

## Backfilling an existing system

You've been using OpenClaw for weeks without hybrid memory. Here's how to catch up:

### Step 1: Install and configure

Follow [QUICKSTART.md](QUICKSTART.md).

### Step 2: Create memory files from session history

Ask your agent:

> "Scan my recent session logs (last 30 days) at `~/.openclaw/agents/main/sessions/`. Create memory files under `memory/` for projects, technical systems, people, and decisions you find. Update MEMORY.md. Output a summary of files created."

### Step 3: Backfill the plugin databases

```bash
# Seed from memory files
EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs

# Extract from daily logs (if you have them)
openclaw hybrid-mem extract-daily --days 30
```

### Step 4: Run session distillation

```bash
# Check distillation window
openclaw hybrid-mem distill-window

# Run distillation (uses Gemini for large context)
# See SESSION-DISTILLATION.md for full pipeline
```

### Step 5: Classify and consolidate

```bash
# Reclassify "other" facts
openclaw hybrid-mem classify --dry-run
openclaw hybrid-mem classify

# Find and merge duplicates
openclaw hybrid-mem find-duplicates --threshold 0.90
openclaw hybrid-mem consolidate --dry-run
openclaw hybrid-mem consolidate
```

### Step 6: Verify

```bash
openclaw hybrid-mem stats
openclaw hybrid-mem verify
```

---

## Writing effective bootstrap files

### AGENTS.md — keep it actionable

Good (rules the agent needs every turn):
```markdown
## Behaviour
- Always respond in English unless the user writes in another language
- Use bullet points for lists of 3+ items
- Never commit secrets to git
```

Bad (reference data that should be in memory files):
```markdown
## API Reference
- Home Assistant API is at http://192.168.1.100:8123
- Frigate is at http://192.168.1.101:5000
- The API key for service X is ...
```

### SOUL.md — personality, not facts

Good:
```markdown
You are a focused, pragmatic assistant. You prefer concrete solutions over abstract discussions.
You use dry humor sparingly. You proactively flag risks.
```

Bad:
```markdown
The user lives in Sweden. Their cat is named Pixel. They work at Company X.
```
(This belongs in `USER.md` or `memory/people/owner.md`)

---

## Monthly maintenance routine

A practical checklist you can follow:

```bash
# 1. Health check
openclaw hybrid-mem verify
openclaw hybrid-mem stats

# 2. Find and clean duplicates
openclaw hybrid-mem find-duplicates --threshold 0.90
openclaw hybrid-mem consolidate --dry-run  # review first
openclaw hybrid-mem consolidate            # apply

# 3. Reclassify uncategorized facts
openclaw hybrid-mem classify --dry-run
openclaw hybrid-mem classify

# 4. Run reflection (extract patterns)
openclaw hybrid-mem reflect --dry-run
openclaw hybrid-mem reflect

# 5. Review memory files
# - Read recent daily logs
# - Update project files
# - Archive completed projects
# - Update MEMORY.md index
```

---

## Related docs

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — Runtime flow explained
- [CONFIGURATION.md](CONFIGURATION.md) — All config options
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [FEATURES.md](FEATURES.md) — Categories, decay, tags
- [MAINTENANCE.md](MAINTENANCE.md) — File hygiene and periodic review
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, scripts, upgrades
