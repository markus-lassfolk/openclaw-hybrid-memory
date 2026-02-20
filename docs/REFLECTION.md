---
layout: default
title: Reflection Layer
parent: Features
nav_order: 6
---
# Reflection Layer: Pattern Synthesis from Session History

## Overview

The **Reflection Layer** analyzes individual facts stored in memory to synthesize **higher-order behavioral patterns** that emerge across multiple sessions. This meta-memory capability helps the agent match your working style without being told every time.

Inspired by:
- [Claude-Diary](https://github.com/rlancemartin/claude-diary) — Three-layer architecture (observations → reflections → rules)
- [Generative Agents paper](https://arxiv.org/abs/2304.03442) — Observation → reflection → planning architecture for believable agent behavior

## Three-Level Memory Hierarchy

```
Observations (existing)     → Individual facts, decisions, preferences
        ↓ reflection job
Patterns (NEW)              → Behavioral patterns, recurring themes, working style
        ↓ optional
Rules (NEW)                 → Actionable one-line directives for agent behavior
```

## How It Works

### 1. Observation Collection

The system gathers recent facts from the last N days (default: 14) using `getRecentFacts()`, excluding pattern and rule categories to avoid recursion:

```typescript
// Facts from the last 14 days (excludes pattern/rule by default)
const recentFacts = factsDb.getRecentFacts(windowDays);
```

### 2. LLM Analysis

Facts are grouped by category and sent to an LLM with a reflection prompt:

```
You are analyzing a user's interaction history to identify behavioral patterns.

Below are facts extracted from the last 14 days of sessions.
Identify recurring patterns — preferences that appear across multiple sessions,
consistent decision-making tendencies, and working-style traits.

Rules:
- Only report patterns supported by 2+ observations
- Be specific and actionable ("prefers X over Y" not "has preferences")
- Each pattern should be 1-2 sentences
- Do not repeat individual facts; synthesize higher-level insights
```

### 3. Pattern Extraction

The LLM response is parsed for patterns (lines starting with `PATTERN:`). Each pattern must be between 20-500 characters to ensure quality and prevent trivial or overly verbose patterns.

```
PATTERN: User consistently favors functional/compositional patterns over OOP
PATTERN: User prefers small, focused code units (functions <20 lines, small PRs)
PATTERN: User values type safety (TypeScript strict mode, explicit types)
```

### 4. Deduplication

Each extracted pattern is checked against existing patterns using cosine similarity (dot product of normalized embeddings). Patterns with ≥85% cosine similarity to existing ones are skipped. This threshold effectively catches paraphrased or semantically equivalent patterns while allowing genuinely distinct insights.

### 5. Storage

New patterns are stored with:
- **Category**: `pattern`
- **Importance**: 0.9 (high priority for recall)
- **Decay class**: `permanent` (never expires)
- **Tags**: `["reflection", "pattern"]`
- **Source**: `reflection`

## Usage

### CLI Command

```bash
# Run reflection on last 14 days (default)
openclaw hybrid-mem reflect

# Custom time window
openclaw hybrid-mem reflect --window 30

# Preview patterns without storing
openclaw hybrid-mem reflect --dry-run

# Use different model
openclaw hybrid-mem reflect --model gpt-4o

# Force run even if reflection is disabled in config
openclaw hybrid-mem reflect --force
```

**Note**: The CLI command checks if reflection is enabled in config. Use `--force` to bypass this check.

### Agent Tool

The agent can trigger reflection on-demand:

```typescript
// Agent calls memory_reflect tool
{
  "window": 14  // optional, defaults to config
}
```

Response:
```json
{
  "factsAnalyzed": 127,
  "patternsExtracted": 5,
  "patternsStored": 3,
  "window": 14
}
```

### Configuration

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "reflection": {
            "enabled": true,
            "model": "gpt-4o-mini",
            "defaultWindow": 14,
            "minObservations": 2
          }
        }
      }
    }
  }
}
```

**Config options:**
- `enabled` (boolean): Enable reflection layer (default: false)
- `model` (string): LLM for reflection analysis (default: "gpt-4o-mini")
- `defaultWindow` (number): Time window in days (default: 14)
- `minObservations` (number): Minimum observations required for a pattern (default: 2)

### Scheduled Job (Optional)

Add a weekly reflection job:

```json
{
  "jobs": [
    {
      "name": "weekly-reflection",
      "schedule": "0 3 * * 0",
      "channel": "system",
      "message": "Run memory reflection: analyze facts from the last 14 days, extract behavioral patterns, store as reflection-category facts.",
      "isolated": true,
      "model": "gemini"
    }
  ]
}
```

## Example Workflow

### Input Observations (last 14 days)

```
[decision] Used functional component over class component (3 sessions)
[decision] Chose composition over inheritance for auth module
[preference] Requested small functions (<20 lines)
[decision] Split large PR into 3 smaller ones
[preference] Asked for TypeScript strict mode
[decision] Rejected ORM in favor of raw SQL queries
[preference] Prefers explicit error handling over try-catch
```

### Reflection Output

```
PATTERN: User consistently favors functional/compositional patterns over OOP
PATTERN: User prefers small, focused code units (functions <20 lines, small PRs)
PATTERN: User values type safety and explicitness (TypeScript strict, explicit errors)
PATTERN: User prefers direct database access over abstractions (raw SQL over ORM)
```

### Storage

Each pattern is stored as a permanent fact with high importance (0.9), making it preferentially recalled in future sessions.

## Integration with Auto-Recall

Patterns are designed to be high-value, low-token facts:

1. **High importance** (0.9) → prioritized in recall ranking
2. **Permanent decay** → never expires
3. **Compact** (1-2 sentences) → token-efficient
4. **Actionable** → directly useful for agent behavior

When auto-recall is enabled, patterns are automatically injected when relevant to the current prompt, helping the agent match your working style from the start of each session.

## Benefits

- **Personality alignment**: Agent matches your working style without being told every time
- **Token-efficient**: One pattern replaces dozens of individual observations
- **Self-improving**: Patterns get refined as more observations accumulate
- **Complements distillation**: Distillation extracts facts; reflection synthesizes patterns from facts
- **Low cost**: One LLM call per week (or on-demand) on a small fact set

## Comparison to Session Distillation

| Feature | Session Distillation | Reflection |
|---------|---------------------|------------|
| **Input** | Raw conversation logs | Stored facts |
| **Output** | Individual facts | Behavioral patterns |
| **Frequency** | Nightly (incremental) | Weekly or on-demand |
| **Scope** | Single session or window | Cross-session synthesis |
| **Purpose** | Extract what was said | Identify how user works |
| **Example** | "User prefers composition" | "User consistently favors composition over inheritance across all projects" |

## Optional Layers (Implemented)

### Rules Layer

Patterns can be synthesized into actionable one-line rules. Run **after** you have at least 2 patterns (e.g. after `openclaw hybrid-mem reflect`).

**CLI:**
```bash
openclaw hybrid-mem reflect-rules              # Synthesize rules from current patterns
openclaw hybrid-mem reflect-rules --dry-run    # Preview without storing
openclaw hybrid-mem reflect-rules --model gpt-4o
openclaw hybrid-mem reflect-rules --force      # Run even if reflection disabled
```

**Agent tool:** `memory_reflect_rules` (no parameters). Returns `{ rulesExtracted, rulesStored }`.

Rules are stored with category `rule`, importance 0.9, decay permanent, tags `["reflection", "rule"]`. Each rule is 10–120 characters; deduplication uses the same 85% cosine similarity threshold as patterns.

**Example output:**
```
RULE: Always suggest composition over inheritance
RULE: Keep functions under 20 lines
RULE: Show error handling before happy path
RULE: Prefer small PRs over large feature branches
```

### Reflection on Reflections (Meta-Patterns)

Existing patterns can be synthesized into 1–3 higher-level meta-patterns (working style, principles). Run when you have at least 3 patterns.

**CLI:**
```bash
openclaw hybrid-mem reflect-meta               # Synthesize meta-patterns from current patterns
openclaw hybrid-mem reflect-meta --dry-run
openclaw hybrid-mem reflect-meta --model gpt-4o
openclaw hybrid-mem reflect-meta --force
```

**Agent tool:** `memory_reflect_meta` (no parameters). Returns `{ metaExtracted, metaStored }`.

Meta-patterns are stored as category `pattern` with tags `["reflection", "pattern", "meta"]`, importance 0.9, permanent. Length 20–300 characters; deduplication against existing meta-patterns.

**Example:**
```
Input: 10 patterns about code style, architecture, workflow
Output: META: User follows functional programming principles with strong emphasis on simplicity and explicitness
```

## Troubleshooting

### Reflection is disabled

**Cause**: The `reflection.enabled` config is set to `false` (default).

**Solution**:
- Enable in config: set `reflection.enabled = true` in `~/.openclaw/openclaw.json`
- Or use `--force` flag to run anyway: `openclaw hybrid-mem reflect --force`

### No patterns extracted

**Cause**: Not enough observations in the time window, or observations are too diverse.

**Solution**:
- Increase `--window` (e.g., `--window 30`)
- Lower `minObservations` in config
- Ensure facts are being captured (check `openclaw hybrid-mem stats`)

### Duplicate patterns

**Cause**: Semantic similarity threshold too low, or patterns are genuinely different.

**Solution**: The system automatically deduplicates at 85% cosine similarity (actual semantic similarity, not euclidean distance). Patterns are also deduplicated within each batch, so even if the LLM returns similar patterns in one run, only the first will be stored. If you still see duplicates, they're considered distinct enough to keep (< 85% similar).

### Patterns too generic

**Cause**: LLM model or prompt needs tuning.

**Solution**:
- Use a more capable model (e.g., `--model gpt-4o`)
- Adjust the reflection prompt in `index.ts` for more specific guidance

## API Reference

### CLI

**Reflect (patterns from facts):**
```bash
openclaw hybrid-mem reflect [options]

Options:
  --window <days>    Time window in days (default: from config or 14)
  --dry-run          Show extracted patterns without storing
  --model <model>    LLM for reflection (default: from config or gpt-4o-mini)
  --force            Run even if reflection is disabled in config
```

**Reflect-rules (rules from patterns):**
```bash
openclaw hybrid-mem reflect-rules [--dry-run] [--model <model>] [--force]
```

**Reflect-meta (meta-patterns from patterns):**
```bash
openclaw hybrid-mem reflect-meta [--dry-run] [--model <model>] [--force]
```

**Note**: All require `reflection.enabled = true` in config, or use `--force` to bypass.

### Tools

**memory_reflect**
```typescript
memory_reflect(params?: { window?: number })
```
Returns: `{ factsAnalyzed, patternsExtracted, patternsStored, window }`

**memory_reflect_rules**
```typescript
memory_reflect_rules()
```
Synthesizes rules from current patterns. Returns: `{ rulesExtracted, rulesStored }`.

**memory_reflect_meta**
```typescript
memory_reflect_meta()
```
Synthesizes meta-patterns from current patterns. Returns: `{ metaExtracted, metaStored }`.

### Config Schema

```typescript
{
  reflection: {
    enabled: boolean;          // Enable reflection layer
    model: string;             // LLM model (default: "gpt-4o-mini")
    defaultWindow: number;     // Time window in days (default: 14)
    minObservations: number;   // Min observations for pattern (default: 2)
  }
}
```

## Credits

- **Claude-Diary** ([github.com/rlancemartin/claude-diary](https://github.com/rlancemartin/claude-diary)): Three-layer architecture (observations → reflections → rules)
- **Generative Agents** (Stanford/Google, arXiv 2304.03442): Foundational paper on observation → reflection → planning for believable agent behavior

---

## Related docs

- [README](../README.md) — Project overview and all docs
- [FEATURES.md](FEATURES.md) — Categories, decay, auto-classify (the observation layer)
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `reflect`, `reflect-rules`, `reflect-meta` commands
- [CONFIGURATION.md](CONFIGURATION.md) — Reflection config in plugin settings
