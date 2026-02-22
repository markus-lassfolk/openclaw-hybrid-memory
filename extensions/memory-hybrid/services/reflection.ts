/**
 * Reflection service: pattern synthesis from memory facts.
 *
 * Three layers:
 * 1. Patterns (runReflection): Extract high-level patterns from recent facts
 * 2. Rules (runReflectionRules): Synthesize patterns into actionable one-liners
 * 3. Meta-patterns (runReflectionMeta): Synthesize patterns into 1-3 meta-patterns
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "./embeddings.js";
import type OpenAI from "openai";
import type { MemoryEntry, MemoryCategory } from "../types/memory.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import {
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  REFLECTION_IMPORTANCE,
  REFLECTION_DEDUPE_THRESHOLD,
  REFLECTION_TEMPERATURE,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_META_MAX_CHARS,
} from "../utils/constants.js";
import { capturePluginError } from "./error-reporter.js";

const REFLECTION_PATTERN_MIN_CHARS = 20;
const REFLECTION_RULE_MIN_CHARS = 10;
const REFLECTION_RULE_MAX_CHARS = 120;
const REFLECTION_META_MIN_CHARS = 20;
const REFLECTION_MAX_PATTERNS_FOR_RULES = 50;
const REFLECTION_MAX_PATTERNS_FOR_META = 30;

export interface ReflectionConfig {
  defaultWindow: number;
  minObservations: number;
  enabled?: boolean;
}

export interface ReflectionOptions {
  window: number;
  dryRun: boolean;
  model: string;
}

export interface ReflectionResult {
  factsAnalyzed: number;
  patternsExtracted: number;
  patternsStored: number;
  window: number;
}

export interface ReflectionRulesResult {
  rulesExtracted: number;
  rulesStored: number;
}

export interface ReflectionMetaResult {
  metaExtracted: number;
  metaStored: number;
}

/**
 * Normalize vector to unit length.
 */
export function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/**
 * Parse PATTERN: lines from reflection LLM response. Exported for tests.
 */
export function parsePatternsFromReflectionResponse(rawResponse: string): string[] {
  const patterns: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*PATTERN:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_PATTERN_MIN_CHARS && text.length <= REFLECTION_PATTERN_MAX_CHARS) {
      patterns.push(text);
    }
  }
  const seenInBatch = new Set<string>();
  const unique: string[] = [];
  for (const p of patterns) {
    const key = p.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    unique.push(p);
  }
  return unique;
}

/**
 * Run reflection — gather recent facts, call LLM to extract patterns, dedupe, store.
 */
export async function runReflection(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  config: ReflectionConfig,
  opts: ReflectionOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ReflectionResult> {
  // Feature-gating: exit 0 if reflection is disabled
  if (config.enabled === false) {
    return { factsAnalyzed: 0, patternsExtracted: 0, patternsStored: 0, window: opts.window };
  }
  const windowDays = Math.min(90, Math.max(1, opts.window));
  const recentFacts = factsDb.getRecentFacts(windowDays);

  if (recentFacts.length < config.minObservations) {
    logger.info(`memory-hybrid: reflection — ${recentFacts.length} facts in window (min ${config.minObservations})`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  // Group by category, cap length and count
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const f of recentFacts) {
    const cat = f.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const arr = byCategory.get(cat)!;
    if (arr.length >= REFLECTION_MAX_FACTS_PER_CATEGORY) continue;
    arr.push(f);
  }

  const factLines: string[] = [];
  for (const [cat, entries] of byCategory) {
    for (const e of entries) {
      const text = e.text.slice(0, REFLECTION_MAX_FACT_LENGTH).trim();
      if (text.length < 10) continue;
      factLines.push(`[${cat}] ${text}`);
    }
  }
  const factsBlock = factLines.join("\n");
  const prompt = fillPrompt(loadPrompt("reflection"), { window: String(windowDays), facts: factsBlock });

  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: REFLECTION_TEMPERATURE,
      max_tokens: 1500,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflection LLM failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'reflection-llm',
      subsystem: 'openai',
      windowDays,
    });
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const uniqueNewPatterns = parsePatternsFromReflectionResponse(rawResponse);

  if (uniqueNewPatterns.length === 0) {
    logger.info(`memory-hybrid: reflection — 0 patterns extracted from LLM`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  // Existing patterns (non-superseded, still valid) for dedupe
  const nowSec = Math.floor(Date.now() / 1000);
  const existingPatternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  let existingVectors: (number[] | null)[] = [];
  if (existingPatternFacts.length > 0) {
    for (let i = 0; i < existingPatternFacts.length; i += 20) {
      const batch = existingPatternFacts.slice(i, i + 20);
      for (const f of batch) {
        try {
          const vec = await embeddings.embed(f.text);
          existingVectors.push(normalizeVector(vec));
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: 'reflection-embed-existing',
            subsystem: 'embeddings',
            factId: f.id,
          });
          existingVectors.push(null);
        }
      }
      if (i + 20 < existingPatternFacts.length) await new Promise((r) => setTimeout(r, 200));
    }
  }

  let stored = 0;
  for (const patternText of uniqueNewPatterns) {
    let vec: number[];
    try {
      vec = await embeddings.embed(patternText);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'embed-pattern',
        severity: 'info',
        subsystem: 'reflection'
      });
      continue; // Skip this pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflection [dry-run] would store: ${patternText.slice(0, 60)}...`);
      stored++;
      continue;
    }

    const entry = factsDb.store({
      text: patternText,
      category: "pattern" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern"],
    });
    try {
      await vectorDb.store({
        text: patternText,
        vector: vec,
        importance: REFLECTION_IMPORTANCE,
        category: "pattern",
        id: entry.id,
      });
    } catch (err) {
      logger.warn(`memory-hybrid: reflection vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'reflection-vector-store',
        subsystem: 'vector',
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;
  }

  return {
    factsAnalyzed: recentFacts.length,
    patternsExtracted: uniqueNewPatterns.length,
    patternsStored: stored,
    window: windowDays,
  };
}

/**
 * Rules layer — synthesize patterns into actionable one-line rules (category "rule").
 */
export async function runReflectionRules(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ReflectionRulesResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_RULES).map((f) => f.text);
  if (patterns.length < 2) {
    logger.info(`memory-hybrid: reflect-rules — need at least 2 patterns, have ${patterns.length}`);
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-rules"), { patterns: patternsBlock });
  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: REFLECTION_TEMPERATURE,
      max_tokens: 800,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-rules LLM failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'reflection-rules-llm',
      subsystem: 'openai',
    });
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const rules: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*RULE:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_RULE_MIN_CHARS && text.length <= REFLECTION_RULE_MAX_CHARS) rules.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueRules: string[] = [];
  for (const r of rules) {
    const key = r.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueRules.push(r);
  }
  if (uniqueRules.length === 0) {
    logger.info("memory-hybrid: reflect-rules — 0 rules extracted from LLM");
    return { rulesExtracted: rules.length, rulesStored: 0 };
  }
  const existingRuleFacts = factsDb.getByCategory("rule").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  let existingVectors: (number[] | null)[] = [];
  for (let i = 0; i < existingRuleFacts.length; i += 20) {
    const batch = existingRuleFacts.slice(i, i + 20);
    for (const f of batch) {
      try {
        existingVectors.push(normalizeVector(await embeddings.embed(f.text)));
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: 'reflection-rules-embed-existing',
          subsystem: 'embeddings',
          factId: f.id,
        });
        existingVectors.push(null);
      }
    }
    if (i + 20 < existingRuleFacts.length) await new Promise((r) => setTimeout(r, 200));
  }
  let stored = 0;
  for (const ruleText of uniqueRules) {
    let vec: number[];
    try {
      vec = await embeddings.embed(ruleText);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'embed-rule',
        severity: 'info',
        subsystem: 'reflection'
      });
      continue; // Skip this rule on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-rules [dry-run] would store: ${ruleText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: ruleText,
      category: "rule" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "rule"],
    });
    try {
      await vectorDb.store({ text: ruleText, vector: vec, importance: REFLECTION_IMPORTANCE, category: "rule", id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-rules vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'reflection-rules-vector-store',
        subsystem: 'vector',
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;
  }
  return { rulesExtracted: rules.length, rulesStored: stored };
}

/**
 * Reflection on reflections — synthesize patterns into 1-3 meta-patterns (stored as pattern + meta tag).
 */
export async function runReflectionMeta(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ReflectionMetaResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_META).map((f) => f.text);
  if (patterns.length < 3) {
    logger.info(`memory-hybrid: reflect-meta — need at least 3 patterns, have ${patterns.length}`);
    return { metaExtracted: 0, metaStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-meta"), { patterns: patternsBlock });
  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: REFLECTION_TEMPERATURE,
      max_tokens: 500,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-meta LLM failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'reflection-meta-llm',
      subsystem: 'openai',
    });
    return { metaExtracted: 0, metaStored: 0 };
  }
  const metas: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*META:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_META_MIN_CHARS && text.length <= REFLECTION_META_MAX_CHARS) metas.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueMetas: string[] = [];
  for (const x of metas) {
    const key = x.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueMetas.push(x);
  }
  if (uniqueMetas.length === 0) {
    logger.info("memory-hybrid: reflect-meta — 0 meta-patterns extracted from LLM");
    return { metaExtracted: metas.length, metaStored: 0 };
  }
  const existingMetaFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec) && (f.tags?.includes("meta") === true),
  );
  let existingVectors: (number[] | null)[] = [];
  for (let i = 0; i < existingMetaFacts.length; i += 20) {
    const batch = existingMetaFacts.slice(i, i + 20);
    for (const f of batch) {
      try {
        existingVectors.push(normalizeVector(await embeddings.embed(f.text)));
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: 'reflection-meta-embed-existing',
          subsystem: 'embeddings',
          factId: f.id,
        });
        existingVectors.push(null);
      }
    }
    if (i + 20 < existingMetaFacts.length) await new Promise((r) => setTimeout(r, 200));
  }
  let stored = 0;
  for (const metaText of uniqueMetas) {
    let vec: number[];
    try {
      vec = await embeddings.embed(metaText);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'embed-meta',
        severity: 'info',
        subsystem: 'reflection'
      });
      continue; // Skip this meta-pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-meta [dry-run] would store: ${metaText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: metaText,
      category: "pattern" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern", "meta"],
    });
    try {
      await vectorDb.store({ text: metaText, vector: vec, importance: REFLECTION_IMPORTANCE, category: "pattern", id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-meta vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'reflection-meta-vector-store',
        subsystem: 'vector',
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;
  }
  return { metaExtracted: metas.length, metaStored: stored };
}
