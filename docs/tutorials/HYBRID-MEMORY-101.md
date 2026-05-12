# Hybrid Memory 101: Getting Started

Welcome to **OpenClaw Hybrid Memory**! This interactive tutorial will guide you through the fundamentals of building AI agents with persistent, intelligent memory.

## What You'll Learn

By the end of this tutorial, you'll understand:
- How hybrid memory works (SQLite + LanceDB)
- Auto-recall and auto-capture mechanisms
- Memory categories, decay, and importance
- Searching and retrieving memories
- Best practices for memory management

**Estimated time:** 30-45 minutes

---

## Chapter 1: Understanding Memory Architecture

### The Problem Memory Solves

Traditional AI agents are stateless - they forget everything after each conversation. This means:
- ❌ No context from previous sessions
- ❌ Users must repeat information
- ❌ No learning or personalization
- ❌ Poor long-term user experience

**Hybrid Memory solves this** by giving agents:
- ✅ Persistent memory across sessions
- ✅ Semantic search for relevant context
- ✅ Automatic capture and recall
- ✅ Intelligent forgetting (decay)

### The Hybrid Approach

OpenClaw Hybrid Memory combines **two complementary storage systems**:

```
┌─────────────────────────────────────────────────┐
│            Your AI Agent                        │
└─────────────┬───────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    │                    │
┌───▼────┐          ┌────▼─────┐
│ SQLite │          │ LanceDB  │
│  FTS5  │          │  Vectors │
└────────┘          └──────────┘
    │                    │
    │                    │
 Exact               Semantic
 Match               Similarity
```

**SQLite FTS5:**
- Full-text search (like Google)
- Instant, zero-cost lookups
- Great for exact matches
- Structured queries (category, tags, entity)

**LanceDB:**
- Vector similarity search
- Finds semantically related memories
- Handles fuzzy/conceptual matches
- Powered by embeddings

**Together:** The best of both worlds - fast exact matches + intelligent semantic retrieval.

### Try It: Your First Memory

Let's store your first memory. Create a file `my-first-memory.ts`:

\`\`\`typescript
import { MemoryClient } from '@openclaw/memory-client';

const client = new MemoryClient({
  baseUrl: 'http://localhost:7777'
});

// Store a preference
await client.createFact({
  text: 'User prefers dark mode in all applications',
  category: 'preference',
  importance: 0.8,
  tags: ['ui', 'theme']
});

console.log('✅ Memory stored!');
\`\`\`

Run it:
\`\`\`bash
npx tsx my-first-memory.ts
\`\`\`

**What happened:**
1. Fact stored in SQLite with metadata
2. Text embedded and stored in LanceDB
3. Now searchable by text OR semantic similarity

---

## Chapter 2: Auto-Recall - Memories Come to You

The magic of Hybrid Memory is **auto-recall** - relevant memories automatically appear in context.

### How Auto-Recall Works

Every conversation turn:
1. Your message is embedded
2. Both SQLite and LanceDB are searched in parallel
3. Results are merged, ranked, and deduplicated
4. Top matches injected into agent context
5. Agent sees them automatically!

**Cost:** ~$0.00002 per turn (or free with local embeddings)

### Example: Dark Mode Memory

You stored: *"User prefers dark mode in all applications"*

Later, you ask: *"What colors should I use for my new app?"*

**Auto-recall finds:**
```xml
<memory-context>
[preference] User prefers dark mode in all applications
</memory-context>
```

Agent responds: *"Based on your preference for dark mode, I'd suggest..."*

**No explicit lookup needed!** The memory surfaced automatically because:
- Vector similarity: "colors" + "app" ≈ "dark mode" + "applications"
- Category match: "preference" is relevant to decision-making
- Importance: 0.8 means high priority

### Try It: Search Your Memories

\`\`\`typescript
// Semantic search
const results = await client.search({
  query: 'what does the user like?',
  limit: 5
});

console.log('Found memories:');
for (const result of results) {
  console.log(\`- [\${result.fact.category}] \${result.fact.text}\`);
  console.log(\`  Score: \${result.score.toFixed(3)}\`);
}
\`\`\`

**Exercise:** Try different queries and observe the relevance scores.

---

## Chapter 3: Auto-Capture - Memories Form Automatically

**Auto-capture** extracts memorable content from agent responses without explicit calls.

### What Gets Captured

The system looks for signals like:
- **Preferences:** "prefer", "like", "want", "hate"
- **Decisions:** "decided", "chose", "will use"
- **Entities:** email addresses, names, "is called"
- **Facts:** "born", "birthday", "lives at", "works for"

### Example: Automatic Preference Capture

**User:** "I like my coffee strong with no sugar"

**Agent:** "Got it! I'll remember you prefer strong coffee without sugar."

**Auto-capture detects:**
- Preference signals: "like", "prefer"
- Entity: user
- Key-value: coffee preferences

**Stored automatically:**
\`\`\`json
{
  "text": "User prefers strong coffee with no sugar",
  "category": "preference",
  "entity": "user",
  "key": "coffee",
  "value": "strong, no sugar",
  "importance": 0.7,
  "decayClass": "stable"
}
\`\`\`

### Security: What's NOT Captured

Auto-capture **never stores**:
- Passwords or API keys
- Credit card numbers
- Social security numbers
- Private keys or tokens

Regex filters catch sensitive patterns before storage.

### Try It: Trigger Auto-Capture

Talk to your agent and use preference language:

```
You: "I prefer TypeScript over JavaScript for all my projects"
Agent: [responds]
```

Then check:
\`\`\`typescript
const prefs = await client.getFacts({
  category: 'preference',
  limit: 10
});

console.log('Your preferences:', prefs);
\`\`\`

---

## Chapter 4: Memory Categories & Decay

Not all memories are equal. Some should last forever, others fade quickly.

### Categories

| Category | Description | Examples |
|----------|-------------|----------|
| **preference** | User likes/dislikes | "Likes dark mode", "Prefers Python" |
| **decision** | Choices made | "Chose PostgreSQL", "Will use React" |
| **entity** | Structured data | "Email: john@example.com", "Birthday: Nov 13" |
| **fact** | General information | "Paris is in France", "Python uses indentation" |
| **other** | Uncategorized | Catch-all for everything else |

### Decay Classes

Memories decay over time unless refreshed:

| Decay Class | Half-life | Use Case |
|-------------|-----------|----------|
| **permanent** | Never | Core identity, critical facts |
| **stable** | 90 days | Preferences, important decisions |
| **episodic** | 30 days | Conversation history, temporary context |
| **volatile** | 7 days | Short-term notes, transient info |

### How Decay Works

Each fact has a **confidence** score (0.0 to 1.0):
- Starts at 1.0 when created
- Decays by 50% after its half-life period
- Falls below 0.1? Hard-deleted
- Gets recalled? Confidence boosted back to 1.0!

**This mimics human memory** - unused memories fade, recalled memories strengthen.

### Try It: Set Decay Classes

\`\`\`typescript
// Critical fact - never forget
await client.createFact({
  text: 'User is allergic to peanuts',
  category: 'entity',
  decayClass: 'permanent',
  importance: 1.0
});

// Temporary note - forget in 7 days
await client.createFact({
  text: 'Working on Q4 presentation this week',
  category: 'other',
  decayClass: 'volatile',
  importance: 0.3
});
\`\`\`

---

## Chapter 5: Searching & Retrieval

### Search Methods

**1. Hybrid Search (Recommended)**
Combines FTS + vector similarity:
\`\`\`typescript
const results = await client.search({
  query: 'what programming languages does user like?',
  minImportance: 0.5,
  limit: 10
});
\`\`\`

**2. Semantic Search**
Vector similarity only:
\`\`\`typescript
const results = await client.semanticSearch(
  'user preferences for development tools',
  10
);
\`\`\`

**3. Structured Lookup**
Exact entity/key lookup:
\`\`\`typescript
const facts = await client.getEntityFacts('user', 'email');
// Returns: [{ text: 'user@example.com', ... }]
\`\`\`

**4. Filtered Queries**
Category, tags, importance filters:
\`\`\`typescript
const important = await client.getFacts({
  category: 'preference',
  tags: ['development'],
  minImportance: 0.7
});
\`\`\`

### Search Best Practices

✅ **Do:**
- Use natural language queries
- Filter by category when you know it
- Use `search()` with `minImportance` when you need importance filtering
- Use entity lookup for structured data

❌ **Don't:**
- Over-filter (let hybrid search work its magic)
- Query with single words (context helps!)
- Ignore decay classes (they matter!)

---

## Chapter 6: Maintenance & Operations

### Background Jobs

These run automatically:
- **Prune** (every 60 min): Delete expired facts
- **Auto-classify** (every 24h): Categorize "other" facts
- **Decay** (every 60 min): Apply confidence decay

### Manual Operations

**Export backup:**
\`\`\`bash
npx openclaw memory backup
\`\`\`

**Restore from backup:**
\`\`\`bash
npx openclaw memory restore backup-2024-01-15.json
\`\`\`

**View statistics:**
\`\`\`typescript
const stats = await client.getStats();
console.log(\`Total facts: \${stats.totalFacts}\`);
console.log(\`Active facts: \${stats.activeFactsCount}\`);
\`\`\`

**Prune old memories:**
\`\`\`typescript
const deleted = await client.pruneFacts(
  Date.now() - (90 * 24 * 60 * 60 * 1000) // 90 days ago
);
console.log(\`Pruned \${deleted} old facts\`);
\`\`\`

---

## Chapter 7: Production Best Practices

### 1. Cost Optimization

**Use local embeddings:**
\`\`\`json
{
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
\`\`\`
Cost: **$0** (vs $0.00002/query with OpenAI)

**Use nano-tier models:**
\`\`\`json
{
  "llm": {
    "tiers": {
      "nano": "gemini-2.5-flash-lite"
    }
  }
}
\`\`\`
Cost: **10× cheaper** than mid-tier

### 2. Performance Tuning

**Limit auto-recall tokens:**
\`\`\`json
{
  "recall": {
    "maxTokens": 800,
    "topK": 10
  }
}
\`\`\`

**Enable query expansion:**
\`\`\`json
{
  "queryExpansion": {
    "enabled": true
  }
}
\`\`\`

### 3. Privacy & Security

- **Never commit** `.openclaw/memory/` to version control
- **Backup regularly** to encrypted storage
- **Use scopes** for multi-tenant applications
- **Review captured facts** periodically

### 4. Monitoring

**Track key metrics:**
- Total facts
- Active vs superseded ratio
- Search latency
- Auto-capture rate
- Monthly API costs

---

## Next Steps

🎓 **Congratulations!** You've completed Hybrid Memory 101.

### Continue Learning

- **[Advanced Memory Engineering](./ADVANCED-MEMORY-ENGINEERING.md)** - Deep dive into architecture, optimization, and advanced patterns
- **[API Reference](./API-REFERENCE.md)** - Complete API documentation
- **[Examples Gallery](./examples/)** - Real-world example applications

### Join the Community

- 💬 [Discord](https://discord.gg/openclaw)
- 🐙 [GitHub Discussions](https://github.com/markus-lassfolk/openclaw-hybrid-memory/discussions)
- 📧 [Newsletter](https://openclaw.dev/newsletter)

### Build Something Amazing

Share your projects using **#OpenClawMemory**!

---

**Ready for more?** → [Advanced Memory Engineering](./ADVANCED-MEMORY-ENGINEERING.md)
