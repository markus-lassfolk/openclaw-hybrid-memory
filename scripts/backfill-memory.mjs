#!/usr/bin/env node
//
// Dynamic backfill for memory-hybrid plugin: discover workspace, glob all
// MEMORY.md and memory/**/*.md (no hardcoded dates or section names), parse
// content, extract facts, write to plugin SQLite + LanceDB.
//
// Run with NODE_PATH set to the memory-hybrid extension's node_modules, or
// from the extension directory. Example:
//   EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
//   NODE_PATH="$EXT_DIR/node_modules" OPENCLAW_WORKSPACE=~/.openclaw/workspace node scripts/backfill-memory.mjs
//   node scripts/backfill-memory.mjs --dry-run
//

import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

const WORKSPACE =
  process.env.OPENCLAW_WORKSPACE || join(homedir(), ".openclaw", "workspace");
const OPENCLAW_ROOT = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_ROOT, "openclaw.json");

// Resolve extension dir for loading deps (better-sqlite3, openai, lancedb)
async function getExtensionDir() {
  if (process.env.OPENCLAW_EXTENSION_DIR) return process.env.OPENCLAW_EXTENSION_DIR;
  try {
    const { execSync } = await import("node:child_process");
    const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    return join(npmRoot, "openclaw", "extensions", "memory-hybrid");
  } catch {
    return join(dirname(import.meta.url), "..", "extensions", "memory-hybrid");
  }
}

function resolveEnvVars(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Missing env: ${name}`);
    return v;
  });
}

function expandPath(p) {
  if (typeof p !== "string") return p;
  return p.replace(/^~/, homedir());
}

// Simple fact extraction (no hardcoded sections — pattern-based)
function extractFact(line) {
  const t = line.replace(/^[-*#>\s]+/, "").trim();
  if (t.length < 10 || t.length > 500) return null;
  const lower = t.toLowerCase();
  if (/\b(api[_-]?key|password|secret|token)\s*[:=]/i.test(t)) return null;
  if (/^(see\s|---|```|\s*$)/.test(t) || t.split(/\s+/).length < 2) return null;

  let entity = null,
    key = null,
    value = null;
  let category = "other";

  const decisionMatch = t.match(
    /(?:decided|chose|picked|went with)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for)\s+(.+?))?\.?$/i
  );
  if (decisionMatch) {
    entity = "decision";
    key = decisionMatch[1].trim().slice(0, 100);
    value = (decisionMatch[2] || "no rationale").trim();
    category = "decision";
  }

  const ruleMatch = t.match(/(?:always|never)\s+(.+?)\.?$/i);
  if (ruleMatch) {
    entity = "convention";
    key = ruleMatch[1].trim().slice(0, 100);
    value = lower.includes("never") ? "never" : "always";
    category = "preference";
  }

  const possessiveMatch = t.match(
    /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/
  );
  if (possessiveMatch) {
    entity = possessiveMatch[1] || "user";
    key = possessiveMatch[2].trim();
    value = possessiveMatch[3].trim();
    category = "fact";
  }

  const preferMatch = t.match(
    /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/
  );
  if (preferMatch) {
    entity = "user";
    key = preferMatch[1];
    value = preferMatch[2].trim();
    category = "preference";
  }

  // Fallback: keep as generic fact so backfill doesn't drop valid bullets
  if (!entity && !key && category === "other") {
    return { text: t, category: "other", entity: null, key: null, value: t.slice(0, 200) };
  }
  return {
    text: t,
    category,
    entity: entity || null,
    key: key || null,
    value: value || t.slice(0, 200),
  };
}

// Collect fact-like lines from content (no hardcoded section names)
function collectLines(content, sourceLabel) {
  const lines = [];
  const raw = content.split(/\n/);
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    lines.push({ line: trimmed, source: sourceLabel });
  }
  return lines;
}

// Glob memory/**/*.md and MEMORY.md under workspace (dynamic)
function gatherFiles(workspaceRoot) {
  const memoryDir = join(workspaceRoot, "memory");
  const memoryMd = join(workspaceRoot, "MEMORY.md");
  const out = [];

  if (existsSync(memoryMd)) out.push({ path: memoryMd, label: "MEMORY.md" });
  if (!existsSync(memoryDir)) return out;

  function walk(dir, rel = "memory") {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const relPath = join(rel, e.name);
      if (e.isDirectory()) walk(full, relPath);
      else if (e.name.endsWith(".md")) out.push({ path: full, label: relPath });
    }
  }
  walk(memoryDir);
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  const pluginConfig = config?.plugins?.entries?.["memory-hybrid"]?.config;
  if (!pluginConfig?.embedding?.apiKey) {
    console.error("memory-hybrid config with embedding.apiKey not found in", CONFIG_PATH);
    process.exit(1);
  }

  const apiKey = resolveEnvVars(pluginConfig.embedding.apiKey);
  const sqlitePath = expandPath(
    pluginConfig.sqlitePath || join(OPENCLAW_ROOT, "memory", "facts.db")
  );
  const lancePath = expandPath(
    pluginConfig.lanceDbPath || join(OPENCLAW_ROOT, "memory", "lancedb")
  );
  const model = pluginConfig.embedding?.model || "text-embedding-3-small";

  const extDir = await getExtensionDir();
  const Database = require(join(extDir, "node_modules", "better-sqlite3"));
  const OpenAIModule = require(join(extDir, "node_modules", "openai"));
  const OpenAI = (OpenAIModule && OpenAIModule.default) || OpenAIModule;
  const lancedb = require(join(extDir, "node_modules", "@lancedb", "lancedb"));

  const openai = new OpenAI({ apiKey });
  const EMBED_DIM =
    model === "text-embedding-3-large" ? 3072 : 1536;
  const LANCE_TABLE = "memories";

  const files = gatherFiles(WORKSPACE);
  if (files.length === 0) {
    console.log("No MEMORY.md or memory/**/*.md under", WORKSPACE);
    process.exit(0);
  }

  const allCandidates = [];
  for (const { path: filePath, label } of files) {
    const content = readFileSync(filePath, "utf-8");
    for (const { line, source } of collectLines(content, label)) {
      const fact = extractFact(line);
      if (fact) allCandidates.push({ ...fact, source });
    }
  }

  if (dryRun) {
    console.log(
      `[dry-run] Would process ${allCandidates.length} facts from ${files.length} files under ${WORKSPACE}`
    );
    allCandidates.slice(0, 15).forEach((f, i) =>
      console.log(`  ${i + 1}. [${f.category}] ${f.entity || "?"}/${f.key || "?"} = ${(f.value || "").slice(0, 50)}...`)
    );
    if (allCandidates.length > 15) console.log("  ...");
    return;
  }

  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.7,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, category, entity, key, value,
      content=facts, content_rowid=rowid,
      tokenize='porter unicode61'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, category, entity, key, value)
      VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
      VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
      VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
      INSERT INTO facts_fts(rowid, text, category, entity, key, value)
      VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
    END
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
    CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
  `);
  const cols = db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name);
  if (!cols.includes("decay_class")) {
    db.exec(`
      ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable';
      ALTER TABLE facts ADD COLUMN expires_at INTEGER;
      ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER;
      ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
    `);
  }
  const hasDup = (text) => db.prepare("SELECT id FROM facts WHERE text = ? LIMIT 1").get(text);

  const nowSec = Math.floor(Date.now() / 1000);
  const stableTtl = 90 * 24 * 3600;
  const insertFact = db.prepare(
    `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stable', ?, ?, 1.0)`
  );

  const conn = await lancedb.connect(lancePath);
  let table;
  const tables = await conn.tableNames();
  if (tables.includes(LANCE_TABLE)) {
    table = await conn.openTable(LANCE_TABLE);
  } else {
    table = await conn.createTable(LANCE_TABLE, [
      {
        id: "__schema__",
        text: "",
        vector: new Array(EMBED_DIM).fill(0),
        importance: 0,
        category: "other",
        createdAt: 0,
      },
    ]);
    await table.delete('id = "__schema__"');
  }

  let stored = 0;
  let skipped = 0;
  for (const fact of allCandidates) {
    if (hasDup(fact.text)) {
      skipped++;
      continue;
    }
    const id = randomUUID();
    insertFact.run(
      id,
      fact.text,
      fact.category,
      0.8,
      fact.entity,
      fact.key,
      fact.value,
      `backfill:${fact.source}`,
      nowSec,
      nowSec + stableTtl,
      nowSec
    );
    const { data } = await openai.embeddings.create({
      model,
      input: fact.text,
    });
    const vector = data[0].embedding;
    await table.add([{ id, text: fact.text, vector, importance: 0.8, category: fact.category, createdAt: nowSec }]);
    stored++;
  }
  db.close();
  console.log(
    `Backfill done: ${stored} new facts stored, ${skipped} duplicates skipped (${allCandidates.length} candidates from ${files.length} files).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
