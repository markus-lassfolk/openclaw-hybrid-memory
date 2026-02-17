# Graph-Based Spreading Activation (FR-007)

## Overview

Graph-Based Spreading Activation extends the hybrid memory system with **typed relationships** between facts, enabling **zero-LLM recall** through graph traversal. This feature addresses a key limitation of pure vector search: **finding conceptually or causally related items** that may not be semantically similar.

### The Problem

Traditional vector search finds semantically similar text but often misses:
- **Causal relationships**: "Why did X fail?" → "Decision Y caused bug Z"
- **Hierarchical relationships**: "What are the components of system X?"
- **Temporal relationships**: "What superseded this decision?"
- **Dependency relationships**: "What does this feature depend on?"

Pure keyword (FTS5) search also fails to capture these structural relationships.

### The Solution

The system now maintains a **graph of typed relationships** between facts in the `memory_links` table. During recall, the system:

1. **Vector/FTS search** finds initial relevant facts (starting nodes)
2. **Graph traversal** (BFS) follows typed links to discover connected facts
3. **Results merging** combines both approaches

This is **zero-LLM** — no embedding calls are needed for graph traversal, making it extremely fast.

---

## Architecture

### Database Schema

#### `memory_links` Table

```sql
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  source_fact_id TEXT NOT NULL,
  target_fact_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

-- Indexes for efficient graph traversal
CREATE INDEX idx_links_source ON memory_links(source_fact_id);
CREATE INDEX idx_links_target ON memory_links(target_fact_id);
CREATE INDEX idx_links_type ON memory_links(link_type);
CREATE INDEX idx_links_source_type ON memory_links(source_fact_id, link_type);
```

#### Link Types

The system supports five typed relationships (inspired by Zep/Graphiti):

| Type | Description | Example |
|------|-------------|---------|
| `SUPERSEDES` | One fact replaces/updates another | "New API key supersedes old API key" |
| `CAUSED_BY` | Causal relationship | "Bug X was caused by decision Y" |
| `PART_OF` | Hierarchical/component relationship | "Feature X is part of project Y" |
| `RELATED_TO` | General semantic relationship | "Dark mode preference relates to VS Code usage" |
| `DEPENDS_ON` | Dependency relationship | "Feature X depends on library Y" |

#### Link Strength

Each link has a `strength` value (0.0-1.0):
- `1.0` = Strong relationship (manually created or high confidence)
- `0.7-0.9` = Moderate relationship (auto-linked with high similarity)
- `0.5-0.6` = Weak relationship (auto-linked with moderate similarity)

---

## Configuration

Add the `graph` section to your plugin config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "graph": {
            "enabled": true,
            "autoLink": true,
            "autoLinkMinScore": 0.7,
            "autoLinkLimit": 3,
            "maxTraversalDepth": 2,
            "useInRecall": true
          }
        }
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable graph features |
| `autoLink` | boolean | `false` | Auto-create RELATED_TO links when storing facts |
| `autoLinkMinScore` | number | `0.7` | Min similarity score for auto-linking (0.0-1.0) |
| `autoLinkLimit` | number | `3` | Max similar facts to auto-link per storage |
| `maxTraversalDepth` | number | `2` | Max hops for graph traversal in recall |
| `useInRecall` | boolean | `true` | Enable graph traversal in memory_recall |

**Recommendation**: Start with `autoLink: false` and manually create links using `memory_link` to establish high-quality relationships. Enable `autoLink: true` later once you have a critical mass of facts.

---

## Usage

### 1. Auto-Linking (Optional)

When `graph.autoLink` is enabled, `memory_store` automatically creates `RELATED_TO` links to the most similar existing facts:

```javascript
// Store a new fact
memory_store({
  text: "Project X uses TypeScript for backend",
  category: "fact"
});

// If autoLink is enabled, the system finds the top 3 most similar facts
// (e.g., "TypeScript requires strict mode") and creates RELATED_TO links
```

**Output:**
```
Stored: "Project X uses TypeScript for backend" [decay: stable] (linked to 2 related facts)
```

### 2. Manual Link Creation

Use `memory_link` to create typed relationships:

```javascript
memory_link({
  sourceFact: "fact-id-1",  // "Decision to migrate to TypeScript"
  targetFact: "fact-id-2",   // "Project X uses TypeScript"
  linkType: "CAUSED_BY",
  strength: 0.9
});
```

**Output:**
```
Created CAUSED_BY link from "Decision to migrate to TypeScript..." to "Project X uses TypeScript..." (strength: 0.9)
```

### 3. Enhanced Recall with Graph Traversal

When `graph.useInRecall` is enabled, `memory_recall` automatically traverses the graph:

```javascript
memory_recall({
  query: "TypeScript configuration"
});
```

**How it works:**
1. Vector/FTS search finds initial matches (e.g., "TypeScript configuration requires strict mode")
2. Graph traversal finds connected facts up to `maxTraversalDepth` hops (e.g., "Decision to migrate to TypeScript", "Project X uses TypeScript")
3. Results are merged and returned

**Output:**
```
Found 5 memories (includes 2 graph-connected facts):

1. [sqlite/technical] TypeScript configuration requires strict mode (95%)
2. [sqlite/fact] Project X uses TypeScript for backend (88%)
3. [sqlite/decision] Decision to migrate to TypeScript was made in Q1 2024 (50%)
4. [sqlite/fact] TypeScript compiler options include strict: true (50%)
5. [sqlite/preference] Team prefers TypeScript over JavaScript (45%)
```

Memories 3-5 were discovered via graph traversal, not by text similarity.

### 4. Graph Exploration

Use `memory_graph` to explore the relationship graph:

```javascript
memory_graph({
  factId: "fact-id-xyz",
  depth: 2  // max 3
});
```

**Output:**
```
Fact: "Project X uses TypeScript for backend"

Direct links (3):
  → [PART_OF] TypeScript configuration requires strict mode (strength: 1.00)
  ← [CAUSED_BY] Decision to migrate to TypeScript was made in Q1 2024 (strength: 0.80)
  ← [DEPENDS_ON] TypeScript configuration requires strict mode (strength: 0.70)

Total connected facts (depth 2): 5
```

---

## Performance

### Zero-LLM Traversal

Graph traversal uses **SQLite joins and indexes** — no embedding calls. Typical performance:
- **1-hop traversal**: ~1-5ms
- **2-hop traversal**: ~5-20ms
- **3-hop traversal**: ~20-50ms

Compare this to vector search (50-200ms per embedding call + search).

### Scaling

- **10,000 facts, 20,000 links**: Traversal remains under 50ms for depth=2
- **100,000 facts, 200,000 links**: Consider reducing `maxTraversalDepth` to 1
- **Foreign key cascades**: When a fact is deleted, all its links are automatically removed

---

## Use Cases

### 1. Causal Reasoning

**Question:** "Why did the Nibe heat pump integration fail?"

**Traditional vector search:** Finds "Nibe integration error" but misses the root cause.

**Graph-enhanced recall:**
1. Vector search finds "Nibe integration error in Home Assistant"
2. Traverse `CAUSED_BY` links → "Zigbee coordinator firmware outdated"
3. Traverse `DEPENDS_ON` links → "Nibe S1155 requires firmware 2.0.4+"

**Result:** Complete causal chain without asking the LLM "why?".

### 2. Project Documentation

**Question:** "What components does Project X have?"

**Setup:**
```javascript
memory_link({
  sourceFact: "project-x-id",
  targetFact: "frontend-id",
  linkType: "PART_OF"
});
memory_link({
  sourceFact: "project-x-id",
  targetFact: "backend-id",
  linkType: "PART_OF"
});
```

**Recall:**
```javascript
memory_recall({ query: "Project X" });
// Returns: Project X + all PART_OF components
```

### 3. Decision History

**Question:** "What superseded the old API key decision?"

**Setup:**
```javascript
memory_link({
  sourceFact: "new-api-key-id",
  targetFact: "old-api-key-id",
  linkType: "SUPERSEDES"
});
```

**Recall:**
```javascript
memory_recall({ query: "API key" });
// Returns: Both API keys, with SUPERSEDES link visible in memory_graph
```

### 4. Auto-Discovery of Related Topics

**Scenario:** User asks about "authentication" but the system has related facts about "OAuth", "JWT", "session management".

**Setup:** Enable `autoLink` with `autoLinkMinScore: 0.7`.

**Result:** When storing "OAuth configuration for API", the system auto-links to "JWT token expiry" and "session timeout settings". Later recall of "authentication" finds all related facts via graph traversal.

---

## Best Practices

### 1. Start Manual, Then Auto-Link

1. **Phase 1**: Disable `autoLink`, manually create high-quality links using `memory_link`
2. **Phase 2**: Once you have 50+ facts, enable `autoLink: true` to discover missed relationships
3. **Phase 3**: Review auto-links with `memory_graph`, delete weak ones, strengthen strong ones

### 2. Use Specific Link Types

Don't default to `RELATED_TO` for everything:
- Use `CAUSED_BY` for causal chains (debugging, decisions)
- Use `PART_OF` for hierarchical structures (projects, systems)
- Use `SUPERSEDES` for versioned facts (credentials, configs)
- Use `DEPENDS_ON` for technical dependencies (libraries, features)
- Use `RELATED_TO` only when no stronger relationship exists

### 3. Prune Weak Links

After auto-linking runs for a while:
1. Query for low-strength links: `SELECT * FROM memory_links WHERE strength < 0.6`
2. Review each one — delete if not useful
3. This improves traversal quality and speed

### 4. Depth vs. Precision

- **depth=1**: Fast, precise, use for interactive queries
- **depth=2**: Balanced, good default for most cases
- **depth=3**: Slower, returns many facts, use only for exploratory queries

---

## Comparison to Competitors

### Zep / Graphiti

**Similarities:**
- Typed relationships (Node-Edge-Node triplets)
- Bi-temporal edges (creation time, validity time)
- Episode nodes for provenance

**Differences:**
- **OpenClaw Hybrid**: SQLite-based, local, zero-cost, privacy-first
- **Graphiti**: Neo4j/cloud-based, managed service, API-priced

### Mem0

**Similarities:**
- Dual storage (vector + graph)
- Auto-extraction of entities and relationships
- Hybrid retrieval (vector narrows, graph enriches)

**Differences:**
- **OpenClaw Hybrid**: Manual + auto links, SQLite recursive CTEs
- **Mem0**: LLM-based extraction, Neo4j/Kuzu backends

### MAGMA

**Inspiration:**
- **Multi-graph concept**: MAGMA uses four orthogonal graphs (semantic, temporal, causal, entity)
- **Future enhancement**: Consider adding `link_category` field to `memory_links` to support multiple graph types

---

## Troubleshooting

### Auto-Linking Not Working

**Check:**
1. `graph.enabled` and `graph.autoLink` are both `true`
2. `graph.autoLinkMinScore` is not too high (try 0.6 instead of 0.8)
3. Vector embeddings are working (check `memory_store` logs)

**Debug:**
```sql
-- Check if links were created
SELECT COUNT(*) FROM memory_links WHERE link_type = 'RELATED_TO';

-- Check auto-link strengths
SELECT strength, COUNT(*) FROM memory_links 
WHERE link_type = 'RELATED_TO' 
GROUP BY ROUND(strength, 1);
```

### Graph Traversal Slow

**Solutions:**
1. Reduce `maxTraversalDepth` from 2 to 1
2. Prune weak links (strength < 0.5)
3. Vacuum database: `sqlite3 facts.db 'VACUUM'`
4. Check index usage: `EXPLAIN QUERY PLAN SELECT ...`

### Too Many Results in Recall

**Solutions:**
1. Lower `maxTraversalDepth`
2. Disable `graph.useInRecall` for specific queries
3. Filter by `link_type` (future enhancement)

---

## Future Enhancements

### 1. Link Categories (MAGMA-style)

Add `link_category` to distinguish graph types:
- `semantic` (RELATED_TO)
- `causal` (CAUSED_BY, DEPENDS_ON)
- `temporal` (SUPERSEDES)
- `hierarchical` (PART_OF)

### 2. Query-Specific Traversal

Allow `memory_recall` to accept `linkTypes` filter:
```javascript
memory_recall({
  query: "Nibe error",
  linkTypes: ["CAUSED_BY", "DEPENDS_ON"]  // Only follow causal links
});
```

### 3. Link Metadata

Add `created_by` (user vs. auto) and `notes` fields to `memory_links` for audit trails.

### 4. Bi-Temporal Edges (Zep-style)

Add `valid_at` / `invalid_at` columns to support superseded links without deletion.

---

## References

- **FR-007 Issue**: Graph-Based Spreading Activation (Zero-LLM Recall)
- **Zep Graphiti**: https://github.com/getzep/graphiti, arXiv:2501.13956
- **Mem0**: https://docs.mem0.ai/features/graph-memory
- **MAGMA**: Multi-Graph Architecture, arXiv:2601.03236
- **SQLite Recursive CTEs**: https://www.sqlite.org/lang_with.html

---

## Quick Reference

### Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_link` | Create typed link | `sourceFact`, `targetFact`, `linkType`, `strength` |
| `memory_graph` | Explore connections | `factId`, `depth` |
| `memory_recall` | Hybrid search | `query` (graph traversal automatic if enabled) |

### Link Types

- `SUPERSEDES`, `CAUSED_BY`, `PART_OF`, `RELATED_TO`, `DEPENDS_ON`

### Config Keys

- `graph.enabled`, `graph.autoLink`, `graph.autoLinkMinScore`, `graph.autoLinkLimit`, `graph.maxTraversalDepth`, `graph.useInRecall`

---

---

## Related docs

- [hybrid-memory-manager-v3.md](hybrid-memory-manager-v3.md) — Documentation hub
- [FEATURES.md](FEATURES.md) — Categories, decay, and other fact features
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture overview
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [CONFIGURATION.md](CONFIGURATION.md) — Graph config settings (`graph.enabled`, `graph.autoLink`, etc.)
