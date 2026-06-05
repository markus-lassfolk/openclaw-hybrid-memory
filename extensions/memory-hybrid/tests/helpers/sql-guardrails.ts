import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEXT_TIMESTAMP_COLUMN_SPECS } from "../../utils/timestamp-migration.js";
import { buildSchemaRegistry, findUnknownSqlColumnViolations, type SqlSchemaRegistry } from "./sql-schema-extract.js";

export const GUARDRAIL_SCAN_ROOTS = ["backends", "services", "cli", "benchmark"] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".js"]);

const ISO_BIND_FORMATTERS = [
  "formatTimestampUtc",
  "cutoffIsoDaysAgo",
  "cutoffIsoHoursAgo",
  "nowIso",
  "normalizeToIsoUtc",
] as const;

const RAW_EPOCH_BIND = /\b(?:sinceSec|nowSec)\b/;

export type GuardrailViolation = {
  file: string;
  rule: string;
  detail: string;
};

let cachedSchemaRegistry: SqlSchemaRegistry | null = null;

export function getSchemaRegistry(pluginRoot: string): SqlSchemaRegistry {
  if (!cachedSchemaRegistry) {
    cachedSchemaRegistry = buildSchemaRegistry(pluginRoot);
  }
  return cachedSchemaRegistry;
}

/** Reset cached registry (tests only). */
export function resetSchemaRegistryCache(): void {
  cachedSchemaRegistry = null;
}

/** Collect non-test source files under scan roots. */
export function collectGuardrailSourceFiles(pluginRoot: string): string[] {
  const out: string[] = [];
  for (const root of GUARDRAIL_SCAN_ROOTS) {
    collectSourceFiles(join(pluginRoot, root), out);
  }
  return out;
}

function collectSourceFiles(dir: string, out: string[]): string[] {
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

export function relativePluginPath(pluginRoot: string, absPath: string): string {
  return absPath.slice(pluginRoot.length + 1);
}

/** Ban datetime(..., 'unixepoch') in live SQL — ISO TEXT columns must not use it. */
export function findDatetimeUnixepochViolations(content: string, file: string): GuardrailViolation[] {
  const pattern = /datetime\s*\([^)]*unixepoch/i;
  if (!pattern.test(content)) return [];
  return [{ file, rule: "no-datetime-unixepoch", detail: "datetime(..., 'unixepoch') in SQL" }];
}

/**
 * When comparing a registered ISO TEXT column, binds must use ISO formatters or *Iso variables —
 * not raw sinceSec/nowSec (lexicographic / wrong-type bugs).
 */
export function findIsoTextColumnRawEpochBindViolations(content: string, file: string): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const { table, columns } of TEXT_TIMESTAMP_COLUMN_SPECS) {
      for (const column of columns) {
        if (!lineReferencesIsoComparison(lines, i, table, column)) continue;

        const window = lines.slice(i, Math.min(lines.length, i + 10)).join("\n");
        if (!/\?\s*[`'"]?\s*\)/.test(window) && !/\?\s*[`'"]?\s*;/.test(window)) continue;
        if (!hasRawEpochBind(window)) continue;
        if (hasIsoBindFormatter(window)) continue;

        violations.push({
          file,
          rule: "iso-text-column-raw-epoch-bind",
          detail: `${table}.${column} compared with ? but bind uses raw sinceSec/nowSec without ISO formatter`,
        });
      }
    }
  }

  return dedupeViolations(violations);
}

function dedupeViolations(violations: GuardrailViolation[]): GuardrailViolation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.rule}:${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineReferencesIsoComparison(lines: string[], startLine: number, table: string, column: string): boolean {
  const window = lines.slice(startLine, Math.min(lines.length, startLine + 4)).join("\n");
  if (!new RegExp(`\\b${column}\\s*[><=]+\\s*\\?`).test(window)) return false;

  if (table === "verified_facts") {
    return /\bverified_facts\b/.test(window) || /\bvf\./.test(window);
  }

  // Ambiguous columns like created_at exist on INTEGER tables too — require table context.
  return new RegExp(`\\b${table}\\b`).test(window);
}

function hasRawEpochBind(window: string): boolean {
  return RAW_EPOCH_BIND.test(window);
}

function hasIsoBindFormatter(window: string): boolean {
  if (ISO_BIND_FORMATTERS.some((name) => window.includes(name))) return true;
  // e.g. sinceIso, cutoffIso passed to .get/.all/.run
  if (/\b[a-zA-Z_]*Iso\b/.test(window)) return true;
  return false;
}

/** SQL must not reference columns missing from the extracted schema registry. */
export function findSchemaUnknownColumnViolations(
  content: string,
  file: string,
  registry: SqlSchemaRegistry,
): GuardrailViolation[] {
  return findUnknownSqlColumnViolations(content, file, registry);
}

export function scanFileForSqlGuardrailViolations(
  pluginRoot: string,
  absPath: string,
  registry = getSchemaRegistry(pluginRoot),
): GuardrailViolation[] {
  const file = relativePluginPath(pluginRoot, absPath);
  const content = readFileSync(absPath, "utf-8");
  return [
    ...findDatetimeUnixepochViolations(content, file),
    ...findIsoTextColumnRawEpochBindViolations(content, file),
    ...findSchemaUnknownColumnViolations(content, file, registry),
  ];
}

export function scanAllSqlGuardrailViolations(pluginRoot: string): GuardrailViolation[] {
  const registry = getSchemaRegistry(pluginRoot);
  return collectGuardrailSourceFiles(pluginRoot).flatMap((absPath) =>
    scanFileForSqlGuardrailViolations(pluginRoot, absPath, registry),
  );
}
