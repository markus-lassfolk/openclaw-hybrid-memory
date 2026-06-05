import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_DDL_SCAN_ROOTS = ["backends", "services"] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".js"]);

const SQL_KEYWORDS = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|WHERE|SET|INTO)\b/i;

/** Well-known table aliases used across the codebase (qualifier -> table). */
export const COMMON_TABLE_ALIASES: Record<string, string> = {
  vf: "verified_facts",
  vf2: "verified_facts",
  f: "facts",
  fe: "fact_embeddings",
  fv: "fact_variants",
  ml: "memory_links",
  pe: "provenance_edges",
  cp: "crystallization_proposals",
  wt: "workflow_traces",
  proc: "procedures",
  p: "procedures",
};

/** SQLite trigger / special qualifiers — not real tables. */
const PSEUDO_QUALIFIERS = new Set(["new", "old"]);

export type SqlSchemaRegistry = Map<string, Set<string>>;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectSourceFiles(fullPath, out);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.js")) continue;
    out.push(fullPath);
  }
  return out;
}

function addColumn(registry: SqlSchemaRegistry, table: string, column: string): void {
  const key = table.toLowerCase();
  const col = column.toLowerCase();
  if (!registry.has(key)) registry.set(key, new Set());
  registry.get(key)!.add(col);
}

function parseColumnDefinitions(body: string): string[] {
  const columns: string[] = [];
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of cleaned) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) continue;
    const match = /^[`"[]?([a-z_][a-z0-9_]*)[`"\]]?\s+/i.exec(trimmed);
    if (match) columns.push(match[1]!.toLowerCase());
  }
  return columns;
}

/** Extract table/column definitions from CREATE TABLE, CREATE VIRTUAL TABLE, and ALTER TABLE DDL. */
export function ingestSchemaDdl(content: string, registry: SqlSchemaRegistry): void {
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(content)) !== null) {
    const table = match[1]!.toLowerCase();
    const openParen = match.index + match[0].length - 1;
    const body = extractBalancedParens(content, openParen);
    if (!body) continue;
    for (const column of parseColumnDefinitions(body)) {
      addColumn(registry, table, column);
    }
  }

  const virtualRe =
    /CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+USING\s+fts5\s*\(/gi;
  while ((match = virtualRe.exec(content)) !== null) {
    const table = match[1]!.toLowerCase();
    const openParen = match.index + match[0].length - 1;
    const body = extractBalancedParens(content, openParen);
    if (!body) continue;
    for (const column of parseFts5Columns(body)) {
      addColumn(registry, table, column);
    }
    addColumn(registry, table, "rowid");
  }

  const alterRe =
    /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi;
  while ((match = alterRe.exec(content)) !== null) {
    addColumn(registry, match[1]!.toLowerCase(), match[2]!.toLowerCase());
  }
}

function extractBalancedParens(content: string, openIndex: number): string | null {
  if (content[openIndex] !== "(") return null;
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return content.slice(openIndex + 1, i);
    }
  }
  return null;
}

function parseFts5Columns(body: string): string[] {
  return body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^tokenize\s*=|^content\s*=|^content_rowid\s*=/i.test(part))
    .map((part) => part.replace(/^[`"[]?([a-z_][a-z0-9_]*)[`"\]]?.*$/i, "$1").toLowerCase())
    .filter(Boolean);
}

export function buildSchemaRegistry(pluginRoot: string): SqlSchemaRegistry {
  const registry: SqlSchemaRegistry = new Map();
  for (const root of SCHEMA_DDL_SCAN_ROOTS) {
    for (const file of collectSourceFiles(join(pluginRoot, root))) {
      ingestSchemaDdl(readFileSync(file, "utf-8"), registry);
    }
  }
  applyImplicitSqliteColumns(registry);
  return registry;
}

/** SQLite rowid and FTS5 auxiliary columns used in queries but not in CREATE TABLE DDL. */
function applyImplicitSqliteColumns(registry: SqlSchemaRegistry): void {
  for (const columns of registry.values()) {
    columns.add("rowid");
  }
  for (const table of registry.keys()) {
    if (table.endsWith("_fts")) {
      registry.get(table)!.add("rank");
    }
  }
}

/** Read live column sets from an open SQLite database. */
export function runtimeSchemaFromDb(db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } }): SqlSchemaRegistry {
  const registry: SqlSchemaRegistry = new Map();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    for (const col of cols) {
      addColumn(registry, name, col.name);
    }
  }
  return registry;
}

export function mergeSchemaRegistries(...registries: SqlSchemaRegistry[]): SqlSchemaRegistry {
  const merged: SqlSchemaRegistry = new Map();
  for (const registry of registries) {
    for (const [table, columns] of registry) {
      if (!merged.has(table)) merged.set(table, new Set());
      for (const col of columns) merged.get(table)!.add(col);
    }
  }
  return merged;
}

export function diffMissingColumns(
  expected: SqlSchemaRegistry,
  actual: SqlSchemaRegistry,
): Array<{ table: string; column: string }> {
  const missing: Array<{ table: string; column: string }> = [];
  for (const [table, cols] of expected) {
    if (table.includes("_fts_")) continue;
    const actualCols = actual.get(table);
    if (!actualCols) {
      for (const column of cols) missing.push({ table, column });
      continue;
    }
    for (const column of cols) {
      if (!actualCols.has(column)) missing.push({ table, column });
    }
  }
  return missing;
}

/** Extract SQL passed to db.prepare(...) or db.exec(...). */
export function extractSqlStrings(content: string): string[] {
  const blocks: string[] = [];
  const patterns = [
    /\.(?:prepare|exec)\(\s*`((?:[^`$]|\$(?!\{)|\$\{[^}]{0,200}\})*)`/g,
    /\.(?:prepare|exec)\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\.(?:prepare|exec)\(\s*'((?:[^'\\]|\\.)*)'/g,
  ];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const sql = match[1]!;
      if (!SQL_KEYWORDS.test(sql)) continue;
      if (/^\s*CREATE\s+(?:TABLE|VIRTUAL|INDEX|TRIGGER)\b/i.test(sql.trim())) continue;
      if (/^\s*ALTER\s+TABLE\b/i.test(sql.trim())) continue;
      if (/^\s*DROP\s+/i.test(sql.trim())) continue;
      blocks.push(sql);
    }
  }
  return blocks;
}

/** Parse FROM/JOIN clauses into alias -> table map for one SQL block. */
export function parseSqlAliasMap(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const clauseRe =
    /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = clauseRe.exec(sql)) !== null) {
    const table = match[1]!.toLowerCase();
    const alias = (match[2] ?? match[1])!.toLowerCase();
    aliases.set(alias, table);
    if (!match[2]) aliases.set(table, table);
  }
  return aliases;
}

export function resolveQualifierToTable(
  qualifier: string,
  aliasMap: Map<string, string>,
  registry: SqlSchemaRegistry,
): string | null {
  const q = qualifier.toLowerCase();
  if (PSEUDO_QUALIFIERS.has(q)) return null;
  if (aliasMap.has(q)) return aliasMap.get(q)!;
  if (COMMON_TABLE_ALIASES[q]) return COMMON_TABLE_ALIASES[q]!;
  if (registry.has(q)) return q;
  return null;
}

export type SchemaColumnViolation = {
  file: string;
  rule: "unknown-sql-column";
  detail: string;
};

export function findUnknownSqlColumnViolations(
  content: string,
  file: string,
  registry: SqlSchemaRegistry,
): SchemaColumnViolation[] {
  if (content.includes("${table}") || content.includes("${column}") || content.includes("${timeCol}")) {
    // Dynamic identifier construction — validated separately at call sites.
    return [];
  }

  const violations: SchemaColumnViolation[] = [];
  const qualifiedRe = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;

  for (const sql of extractSqlStrings(content)) {
    const aliasMap = parseSqlAliasMap(sql);
    let match: RegExpExecArray | null;
    qualifiedRe.lastIndex = 0;
    while ((match = qualifiedRe.exec(sql)) !== null) {
      const qualifier = match[1]!;
      const column = match[2]!.toLowerCase();
      const table = resolveQualifierToTable(qualifier, aliasMap, registry);
      if (!table) continue;
      const columns = registry.get(table);
      if (!columns) continue;
      if (columns.has(column)) continue;
      if (column === "rowid") continue;
      if (column === "rank" && table.endsWith("_fts")) continue;
      violations.push({
        file,
        rule: "unknown-sql-column",
        detail: `${qualifier}.${column} → table '${table}' has no column '${column}'`,
      });
    }
  }

  return dedupeViolations(violations);
}

function dedupeViolations<T extends { rule: string; detail: string }>(violations: T[]): T[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.rule}:${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
