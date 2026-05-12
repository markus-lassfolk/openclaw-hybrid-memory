# OpenClaw Memory Client SDK

Official TypeScript/JavaScript SDK for OpenClaw Hybrid Memory

[![npm version](https://badge.fury.io/js/%40openclaw%2Fmemory-client.svg)](https://www.npmjs.com/package/@openclaw/memory-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

\`\`\`bash
npm install @openclaw/memory-client
\`\`\`

\`\`\`bash
yarn add @openclaw/memory-client
\`\`\`

\`\`\`bash
pnpm add @openclaw/memory-client
\`\`\`

## Quick Start

\`\`\`typescript
import { MemoryClient } from '@openclaw/memory-client';

// Initialize client
const client = new MemoryClient({
  baseUrl: 'http://localhost:7777', // Your OpenClaw instance
  apiKey: process.env.MEMORY_API_KEY // Optional for cloud
});

// Store a memory
const fact = await client.createFact({
  text: 'User prefers dark mode in all applications',
  category: 'preference',
  importance: 0.8,
  tags: ['ui', 'theme']
});

// Search memories
const results = await client.search({
  query: 'what are user preferences?',
  limit: 10
});

console.log('Found memories:', results);
\`\`\`

## API Reference

### Constructor

\`\`\`typescript
new MemoryClient(config?: MemoryClientConfig)
\`\`\`

**Config Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | `http://localhost:7777` | Base URL of memory API |
| `graphqlPath` | `string` | `/plugins/memory/graphql` | GraphQL endpoint path |
| `apiKey` | `string` | `undefined` | API key for authentication |
| `timeout` | `number` | `30000` | Request timeout in ms |

### Methods

#### `getFact(id: string): Promise<Fact | null>`

Get a single fact by ID.

\`\`\`typescript
const fact = await client.getFact('fact-123');
if (fact) {
  console.log(fact.text);
}
\`\`\`

#### `getFacts(options?): Promise<Fact[]>`

Get multiple facts with filtering.

\`\`\`typescript
const facts = await client.getFacts({
  category: 'preference',
  limit: 20,
  offset: 0,
  tags: ['development']
});
\`\`\`

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `limit` | `number` | Max results (default: 100) |
| `offset` | `number` | Skip N results (pagination) |
| `category` | `string` | Filter by category |
| `decayClass` | `string` | Filter by decay class |
| `tags` | `string[]` | Filter by tags |
| `scope` | `string` | Filter by scope |
| `includeSuperseded` | `boolean` | Include superseded facts |
| `includeExpired` | `boolean` | Include expired facts |

#### `search(input: SearchInput): Promise<SearchResult[]>`

Hybrid search (FTS + vector similarity).

\`\`\`typescript
const results = await client.search({
  query: 'user preferences for development tools',
  categories: ['preference'],
  minImportance: 0.7,
  limit: 10
});

for (const result of results) {
  console.log(\`[\${result.fact.category}] \${result.fact.text}\`);
  console.log(\`Score: \${result.score.toFixed(3)}\`);
}
\`\`\`

**SearchInput:**

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | Search query (required) |
| `categories` | `string[]` | Filter by categories |
| `decayClasses` | `string[]` | Filter by decay classes |
| `tags` | `string[]` | Filter by tags |
| `minImportance` | `number` | Minimum importance (0-1) |
| `minConfidence` | `number` | Minimum confidence (0-1) |
| `limit` | `number` | Max results |
| `offset` | `number` | Skip N results |
| `scope` | `string` | Filter by scope |

#### `semanticSearch(query: string, limit?: number, scope?: string): Promise<SearchResult[]>`

Vector similarity search only.

\`\`\`typescript
const results = await client.semanticSearch(
  'what programming languages does user like?',
  10
);
\`\`\`

#### `createFact(input: CreateFactInput): Promise<Fact>`

Create a new fact.

\`\`\`typescript
const fact = await client.createFact({
  text: 'User is allergic to peanuts',
  category: 'entity',
  importance: 1.0,
  confidence: 1.0,
  decayClass: 'permanent',
  tags: ['health', 'allergy'],
  entity: 'user',
  key: 'allergy',
  value: 'peanuts'
});
\`\`\`

**CreateFactInput:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | ✅ | Fact content |
| `category` | `string` | ❌ | Category (default: "other") |
| `importance` | `number` | ❌ | Importance 0-1 (default: 0.5) |
| `confidence` | `number` | ❌ | Confidence 0-1 (default: 1.0) |
| `decayClass` | `string` | ❌ | Decay class (default: "episodic") |
| `source` | `string` | ❌ | Source identifier |
| `tags` | `string[]` | ❌ | Tags for organization |
| `entity` | `string` | ❌ | Entity name |
| `key` | `string` | ❌ | Entity key |
| `value` | `string` | ❌ | Entity value |
| `scope` | `string` | ❌ | Memory scope |
| `scopeTarget` | `string` | ❌ | Scope target |
| `expiresAt` | `number` | ❌ | Expiration timestamp |

#### `updateFact(input): Promise<Fact>`

Update an existing fact.

\`\`\`typescript
const updated = await client.updateFact({
  id: 'fact-123',
  text: 'Updated text',
  importance: 0.9,
  tags: ['new-tag']
});
\`\`\`

#### `deleteFact(id: string): Promise<boolean>`

Delete a fact.

\`\`\`typescript
const deleted = await client.deleteFact('fact-123');
console.log('Deleted:', deleted);
\`\`\`

#### `getStats(): Promise<MemoryStats>`

Get memory statistics.

\`\`\`typescript
const stats = await client.getStats();
console.log(\`Total facts: \${stats.totalFacts}\`);
console.log(\`Active facts: \${stats.activeFactsCount}\`);

for (const cat of stats.factsByCategory) {
  console.log(\`\${cat.category}: \${cat.count}\`);
}
\`\`\`

#### `getGraph(filter?): Promise<GraphData>`

Get graph visualization data.

\`\`\`typescript
const graph = await client.getGraph({
  categories: ['preference', 'decision'],
  minImportance: 0.5
});

console.log(\`Nodes: \${graph.nodes.length}\`);
console.log(\`Edges: \${graph.edges.length}\`);
\`\`\`

#### `getEntityFacts(entity: string, key?: string): Promise<Fact[]>`

Get facts for a specific entity.

\`\`\`typescript
const userFacts = await client.getEntityFacts('user');
const emailFact = await client.getEntityFacts('user', 'email');
\`\`\`

#### `importFacts(facts: CreateFactInput[]): Promise<Fact[]>`

Bulk import facts.

\`\`\`typescript
const imported = await client.importFacts([
  { text: 'Fact 1', category: 'preference' },
  { text: 'Fact 2', category: 'decision' },
  { text: 'Fact 3', category: 'entity' }
]);

console.log(\`Imported \${imported.length} facts\`);
\`\`\`

#### `pruneFacts(olderThan?: number, category?: string): Promise<number>`

Prune old facts.

\`\`\`typescript
// Delete facts older than 90 days
const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
const deleted = await client.pruneFacts(ninetyDaysAgo);

console.log(\`Pruned \${deleted} facts\`);
\`\`\`

## Types

### Fact

\`\`\`typescript
interface Fact {
  id: string;
  text: string;
  category: string;
  importance: number;
  confidence: number;
  decayClass: string;
  source?: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  expiresAt?: number;
  supersededBy?: string;
  entity?: string;
  key?: string;
  value?: string;
  scope?: string;
  scopeTarget?: string;
  metadata?: Record<string, unknown>;
}
\`\`\`

### SearchResult

\`\`\`typescript
interface SearchResult {
  fact: Fact;
  score: number;
  matchType: string;
  snippet?: string;
}
\`\`\`

### MemoryStats

\`\`\`typescript
interface MemoryStats {
  totalFacts: number;
  activeFactsCount: number;
  expiredFactsCount: number;
  supersededFactsCount: number;
  factsByCategory: Array<{ category: string; count: number }>;
  factsByDecayClass: Array<{ decayClass: string; count: number }>;
  totalEpisodes: number;
  totalLinks: number;
  databaseSizeBytes: number;
  oldestFactDate?: number;
  newestFactDate?: number;
}
\`\`\`

## Examples

### Personal Assistant Bot

\`\`\`typescript
import { MemoryClient } from '@openclaw/memory-client';

const memory = new MemoryClient();

// User tells bot their preferences
await memory.createFact({
  text: 'User prefers Python for data analysis',
  category: 'preference',
  tags: ['programming', 'data-science'],
  importance: 0.8
});

// Later, when user asks for recommendations
const results = await memory.search({
  query: 'what tools should I use for data analysis?',
  categories: ['preference'],
  limit: 5
});

// Bot sees: "User prefers Python for data analysis"
// Bot responds with Python-specific recommendations
\`\`\`

### Customer Support Agent

\`\`\`typescript
// Store customer information
await memory.createFact({
  text: 'Customer uses Enterprise plan with 50 seats',
  category: 'entity',
  entity: 'customer:acme-corp',
  key: 'plan',
  value: 'enterprise-50',
  decayClass: 'stable'
});

// Store support history
await memory.createFact({
  text: 'Customer reported login issues on 2024-01-15, resolved with password reset',
  category: 'fact',
  entity: 'customer:acme-corp',
  tags: ['support', 'login', 'resolved'],
  importance: 0.6
});

// Retrieve all customer facts
const customerFacts = await memory.getEntityFacts('customer:acme-corp');
\`\`\`

### Research Assistant

\`\`\`typescript
// Store research findings
await memory.createFact({
  text: 'Study by Smith et al. (2023) found 30% improvement in accuracy using attention mechanisms',
  category: 'fact',
  tags: ['research', 'ml', 'attention', 'paper:smith2023'],
  importance: 0.9,
  source: 'arxiv:2023.12345'
});

// Semantic search for related findings
const related = await memory.semanticSearch(
  'improvements in neural network accuracy',
  10
);
\`\`\`

## Error Handling

\`\`\`typescript
try {
  const fact = await client.getFact('non-existent-id');
} catch (error) {
  if (error.message.includes('GraphQL errors')) {
    console.error('API error:', error);
  } else if (error.message.includes('request failed')) {
    console.error('Network error:', error);
  } else {
    console.error('Unknown error:', error);
  }
}
\`\`\`

## TypeScript Support

Full TypeScript support with type definitions included.

\`\`\`typescript
import type { Fact, SearchResult, MemoryStats } from '@openclaw/memory-client';

function processFact(fact: Fact): void {
  // TypeScript knows all Fact properties
  console.log(fact.text);
  console.log(fact.importance);
}
\`\`\`

## License

MIT

## Links

- [GitHub Repository](https://github.com/markus-lassfolk/openclaw-hybrid-memory)
- [Documentation](https://openclaw-hybrid-memory.dev)
- [Issues](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues)
- [Discord Community](https://discord.gg/openclaw)
