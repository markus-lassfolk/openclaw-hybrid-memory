# Give Your Clawdbot Permanent Memory

**Source:** [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)  
**Captured:** 2026-02-15  
**Original date:** February 13, 2026 · 41 min read

---

After my last Clawdbot 101 post, I have been getting a ton of messages asking for advice and help. I've been trying to solve what I think is the hardest problem with Clawdbot space: making your bot actually remember things properly. I have been working on the solution behind this post all week. And no, I am not sponsored by Supermemory like some people are suggesting, lol.

As for my Clawdbot, his name is Ziggy and like others, I have been trying to work out the best way to structure memory and context so he can be the best little Clawbot possible.

I have seen a lot of posts on Reddit about context loss mid-conversation, let alone having memory over time. My goal here has to build real memory without the need for constant management. The kind where I can mention my daughter's birthday once in a passing conversation, and six months later Ziggy just knows it without having to do a manual Cron setup for memorization. This post walks through the iterations I went through to get to my solution, a couple of wrong turns, some extra bits I picked up from other Reddit posts, and the system I ended up building.

I warn you all that this is a super-long post. If you are interested in understanding the process and the thought behind it, read on. If you just want to know how to implement it and get the TLDR version - it's at the bottom.

## The Problem Everyone Hits

As we all know with using AI assistants - every conversation has to start fresh. You explain the same context over and over. Even within long sessions, something called context compression quietly eats your older messages. The agent is doing great, the conversation is flowing, and then suddenly it "forgets" something you said twenty messages ago because the context window got squeezed. Clawdbot in particular is particularly susceptible to this as there's typically no warning window that your context is running out, it just "forgets" mid-conversation.

The AI agent community calls this context compression amnesia. A Reddit post about it pulled over a thousand upvotes because literally everyone building agents has hit this. And let's face it - an assistant that can't remember what you told it yesterday isn't really your assistant. It's a stranger you have to re-introduce yourself to every context window.

## Attempt #1: The Big Markdown File

My first approach was the simplest possible thing. A file called MEMORY.md that gets injected into the system prompt on every single turn. Critical facts about me, my projects, my preferences - all just sitting there in plain text:

```markdown
## Identity
- Name: Adam
- Location: USA
- Etc.

## Projects
- Clawdbot: Personal AI assistant on home server
```

This actually works pretty well for a small set of core facts. The problem is obvious: it doesn't scale. Every token in that file costs money on every message. You can't put your entire life in a system prompt. And deciding what goes in vs. what gets left out becomes its own project.

But with that said - I still use MEMORY.md. It's still part of the foundation of the final system. The trick is keeping it lean - twenty or thirty critical facts, and not your whole life story.

## Attempt #2: Vector Search With LanceDB

The natural next step was a vector database. The idea is simple: convert your memories into numerical vectors (embeddings), store them, and when a new message comes in, convert that into a vector too and find the most similar memories. It's called semantic search - it can find related content even when the exact words don't match.

I chose LanceDB because it's embedded in the Clawdbot setup. It runs in-process with no separate server, similar to how SQLite works for relational data. Entirely local, so no cloud dependency. I wrote a seed script, generated embeddings via OpenAI's text-embedding-3-small model, and configured the retrieval hook to pull the top 3 most similar memories before every response.

It worked. Ziggy could suddenly recall things from old conversations. But as I used it more, three main cracks appeared that I wanted to fix.

### The Precision Problem

Ask "what's my daughter's birthday?" and vector search returns the three memories most similar to that question. If my memory store has entries about her birthday or her activities where she's mentioned by name, I might get three ballet-related chunks instead of the one birthday entry. So for precise factual lookups, vector search wasn't the right tool.

### The Cost and Latency Tax

Every memory you store needs an API call to generate its embedding. Every retrieval needs one too - the user's message has to be embedded before you can search. That's two API calls per conversation turn just for memory, on top of the LLM call itself. The per-call cost with text-embedding-3-small is tiny, but the latency adds up. And if OpenAI's embedding endpoint goes down? Your entire memory system breaks even though LanceDB itself is happily running locally, so it effectively trades one cloud dependency for another.

### The Chunking Problem

When you split your memory files into chunks for embedding, every boundary decision matters. Too small and you lose context, but if it's too large, the embeddings get diluted. A bad split can break a critical fact across two vectors, making neither one properly retrievable. There's no universal right answer, and the quality of your whole system depends on decisions you made once during setup and probably won't revisit again.

I started to realise that about 80% of questions are basically structured lookups - "what's X's Y?" - so it was a pretty big overkill.

### The Turning Point: Most Memory Queries Are Structured

I stepped back and looked at what I was actually asking Ziggy to remember:

- "My daughter's birthday is June 3rd"
- "I prefer dark mode"
- "We decided to use LanceDB over Pinecone because of local-first requirements"
- "My email is ..."
- "I always run tests before deploying" (not always true, lol)

These aren't fuzzy semantic search queries, they are structured facts:

| Entity   | Key                 | Value        |
|----------|---------------------|--------------|
| Daughter | birthday            | June 3rd     |
| User     | preference          | dark mode    |
| Decision | LanceDB over Pinecone | local-first for Clawdbot |

For these, you don't need vector search. You need something more like a traditional database with good full-text search. That's when SQLite with FTS5 entered the picture.

## Attempt #3: The Hybrid System

The design I landed on uses both approaches together, each doing what it's best at.

**SQLite + FTS5** handles structured facts. Each memory is a row with explicit fields: category, entity, key, value, source, timestamp. FTS5 (Full-Text Search 5) gives you instant text search with BM25 ranking - no API calls, no embedding costs, no network. When I ask "what's my daughter's birthday?", it's a text match that returns in milliseconds.

**LanceDB** stays for semantic search. "What were we discussing about infrastructure last week?" - questions where exact keywords don't exist but the meaning is close. Basically, just picking the best tool for the job.

The retrieval flow works as a cascade:

1. User message arrives
2. SQLite FTS5 searches the facts table (instant and free - no API usage)
3. LanceDB embeds the query and does vector similarity (~200ms, one API call)
4. Results merge, deduplicate, and sort by a composite score
5. Top results get injected into the agent's context alongside MEMORY.md

For storage, structured facts (names, dates, preferences, entities) go to SQLite with auto-extracted fields. Everything also gets embedded into LanceDB, making it a superset. SQLite is the fast path, while LanceDB is the backup safety net.

This solved all three problems from the vector-only approach. Factual lookups hit SQLite and return exact matches. Most queries never touch the embedding API so there's no cost. Structured facts in SQLite don't need chunking.

## Community Insights: Memory Decay and Decision Extraction

During the week, I had setup Ziggy to scan Moltbook and MoltCities about memory patterns to see what else was out there that I could integrate. I also had some interesting stuff DM'd to me about memory by u/Appropriate-Skirt25. There were two ideas from this that I wanted to integrate:

### Not All Memories Should Live Forever

"I'm currently putting together my morning brief schedule" is useful right now and irrelevant next week. "My daughter's birthday is June 3rd" should remain forever. A flat memory store treats everything the same, which means stale facts accumulate and pollute your retrieval results.

So I setup a decay classification system and split these into five tiers of memory lifespan:

| Tier       | Examples                                                    | TTL            |
|------------|-------------------------------------------------------------|----------------|
| Permanent  | names, birthdays, API endpoints, architectural decisions    | Never expires  |
| Stable     | project details, relationships, tech stack                 | 90-day TTL, refreshed on access |
| Active     | current tasks, sprint goals                                 | 14-day TTL, refreshed on access |
| Session    | debugging context, temp state                              | 24 hours       |
| Checkpoint | pre-flight state saves                                     | 4 hours        |

Facts get auto-classified based on the content pattern. The system will detect what kind of information it's looking at and then it will assign it to the right decay class without manual tagging.

The key detail is Time-To-Live (TTL) refresh on access. If a "stable" fact (90-day TTL) keeps getting retrieved because it's relevant to ongoing work, its expiry timer resets every time. Facts that matter stay alive in Ziggy's memory. Facts that stop being relevant quietly expire and get pruned automatically. I then setup a background job to run every hour to clean up.

### Decisions Survive Restarts Better Than Conversations

One community member tracks over 37,000 knowledge vectors and 5,400 extracted facts. The pattern that emerged: compress memory into decisions that survive restarts, not raw conversation logs.

"We chose SQLite + FTS5 over pure LanceDB because 80% of queries are structured lookups" - that's not just a preference, it's a decision with rationale. If the agent encounters a similar question later, having the why alongside the what is incredibly valuable. So the system now auto-detects decision language and extracts it into permanent structured facts:

- "We decided to use X because Y" → entity: decision, key: X, value: Y
- "Chose X over Y for Z" → entity: decision, key: X over Y, value: Z
- "Always/never do X" → entity: convention, key: X, value: always or never

This way, decisions and conventions get classified as permanent and they never decay.

## Pre-Flight Checkpoints

Another community pattern I adopted: setup a save state before risky operations. If Ziggy is about to do a long multi-step task - editing files, running builds, deploying something - he saves a checkpoint: what he's about to do, the current state, expected outcome, which files he's modifying.

If context compression hits mid-task, the session crashes, or the agent just loses the plot, the checkpoint is there to restore from. It's essentially a write-ahead log for agent memory. Checkpoints auto-expire after 4 hours since they're only useful in the short term. This solves the biggest pain point for Clawdbot - short-term memory loss.

## Daily File Scanning

The last piece is a pipeline that scans daily memory log files and extracts structured facts from them. If I've been having conversations all week and various facts came up naturally, a CLI command can scan those logs, apply the same extraction patterns, and backfill the SQLite database.

```bash
# Dry run - see what would be extracted
openclaw hybrid-mem extract-daily --dry-run --days 14

# Actually store the extracted facts
openclaw hybrid-mem extract-daily --days 14
```

This means the system gets smarter even from conversations that happened before auto-capture was turned on. It's also a backup safety net - if auto-capture misses something during a conversation, the daily scan can catch it later.

## What I'd Do Differently

If I were starting from scratch:

- **Start with SQLite, not vectors** — I went straight to LanceDB because vector search felt like the "AI-native" approach. But for a personal assistant, most memory queries are structured lookups. SQLite + FTS5 would have covered 80% of my needs from day one with zero external dependencies.
- **Design for decay from the start** — I added TTL classification as a migration. If I'd built it in from the beginning, I'd have avoided accumulating stale facts that cluttered retrieval results in the first instance.
- **Extract decisions explicitly from the start** — This was the last feature I added, but it's arguably the most valuable. Raw conversation logs are noise and distilled decisions with rationale are fundamentally clearer.

## The Bottom Line

AI agent memory is still an unsolved problem in the broader ecosystem, but it's very much solvable for Clawdbot in my opinion. The key insight is that building a good "memory" system isn't one thing - it's multiple systems with different characteristics serving different query patterns.

Vector search is brilliant for fuzzy semantic recall, but it's expensive and imprecise for the majority of factual lookups a personal assistant actually needs. A hybrid approach - structured storage for precise facts, vector search for contextual recall, always-loaded context for critical information, and time-aware decay for managing freshness - covers the full spectrum.

It's more engineering than a single vector database, but the result is an assistant that genuinely remembers.

---

## TLDR Version

I built a 3-tiered memory system to incorporate short-term and long-term fact retrieval memory using a combination of vector search and factual lookups, with good old memory.md added into the mix. It uses LanceDB (native to OpenClaw in your installation) and SQLite with FTS5 (Full Text Search 5) to give you the best setup for the memory patterns for your Clawdbot (in my opinion).

---

## Installation Info and Dependencies

### npm Packages

| Package            | Version   | Purpose |
|--------------------|-----------|--------|
| `better-sqlite3`   | ^11.0.0   | SQLite driver with FTS5 full-text search — native addon, requires C++ compilation |
| `@lancedb/lancedb` | ^0.23.0   | Embedded vector database for semantic search |
| `openai`           | ^6.16.0   | OpenAI SDK for generating embeddings |
| `@sinclair/typebox`| 0.34.47   | Runtime type validation for plugin config |

### Build Tools (required to compile better-sqlite3)

| Platform | Requirement |
|----------|-------------|
| Windows  | Visual Studio Build Tools 2022 with "Desktop development with C++" workload |
| Linux    | `build-essential`, `python3` |

### API Keys

| Key                  | Required | Purpose |
|----------------------|----------|---------|
| `OPENAI_API_KEY`     | Yes      | Embedding generation via `text-embedding-3-small` |
| `SUPERMEMORY_API_KEY`| No       | Cloud archive tier (Tier 2) |

---

## Setup Prompts

**Note:** The `clawdbot` npm package has been renamed to `openclaw`. The prompts below use the new `openclaw` package name. If you're still on the old `clawdbot` package, [migrate first](https://www.getopenclaw.ai/help/update-stuck-old-version-npm).

Want to install the memory-hybrid plugin yourself? Below are four prompts you can paste into your AI assistant in order. Each one is self-contained. You need an existing OpenClaw installation (formerly Clawdbot) and an OpenAI API key before you start.

### Prompt 1: Create the Plugin Files

See [Setup prompt 1](./SETUP-PROMPT-1-CREATE-PLUGIN-FILES.md) in this repo (or the corresponding section in the original post).

### Prompt 2: Install Dependencies

See [Setup prompt 2](./SETUP-PROMPT-2-INSTALL-DEPENDENCIES.md).

### Prompt 3: Configure and Start

See [Setup prompt 3](./SETUP-PROMPT-3-CONFIGURE-AND-START.md).

### Prompt 4: Seed from Existing Memory Files (Optional)

See [Setup prompt 4](./SETUP-PROMPT-4-SEED-FROM-MEMORY-FILES.md).

---

## Source Code

The full source code for the plugin lives in this repo under `extensions/memory-hybrid/`:

- **config.ts** — Decay classes, TTL defaults, config schema and parsing.
- **index.ts** — Plugin entry: SQLite+FTS5 backend, LanceDB backend, merge/dedupe, lifecycle hooks, CLI commands.

Original article: [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory).
