# Prompt 4: Seed from Existing Memory Files (Optional)

Paste this into your AI assistant:

```
My memory-hybrid plugin is running but the databases are empty. I have
existing memory files I want to import.

Create a seed script at ~/.openclaw/seed-hybrid.mjs that:

1. Reads MEMORY.md from ~/.openclaw/MEMORY.md
2. Parses each line/section into individual facts
3. For each fact:
   a. Detect the category (preference, fact, decision, entity, other)
   b. Extract structured fields (entity/key/value) from patterns like:
      - "X's Y is Z" -> entity: X, key: Y, value: Z
      - "I prefer X" -> entity: user, key: prefer, value: X
      - "We decided X because Y" -> entity: decision, key: X, value: Y
   c. Store in SQLite (same schema as the plugin)
   d. Generate an embedding via OpenAI text-embedding-3-small
   e. Store the vector in LanceDB
   f. Skip duplicates (exact text match for SQLite, >95% cosine similarity
      for LanceDB)
4. Also scan any daily memory files in ~/.openclaw/memory/YYYY-MM-DD.md
5. Read the OpenAI API key from openclaw.json at
   ~/.openclaw/openclaw.json (resolve ${OPENAI_API_KEY} from environment)
6. Database paths:
   - SQLite: ~/.openclaw/memory/facts.db
   - LanceDB: ~/.openclaw/memory/lancedb

Adapt the MEMORY.md parser to match the structure of MY memory file — look
at its actual format and parse accordingly.

Run with: cd ~/.openclaw && node seed-hybrid.mjs
```
