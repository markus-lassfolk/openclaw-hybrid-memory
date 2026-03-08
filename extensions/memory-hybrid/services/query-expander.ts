/**
 * Query Expander Service (Issue #160).
 *
 * At retrieval time, expand the user's query into 3-5 variant queries via LLM,
 * then search against all variants and merge results via RRF. This bridges
 * vocabulary gaps at query time (complementing #159's index-time variants).
 *
 * Key design:
 * - LRU cache to memoize expansions for identical queries.
 * - Timeout: if LLM takes >5s, fall back to original query only.
 * - Graceful degradation: any failure returns [original query].
 * - Optional context parameter improves expansion quality.
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import type { QueryExpansionConfig } from "../config.js";
import { extractJsonArray } from "./json-array-parser.js";

// ---------------------------------------------------------------------------
// Rule-based alias expansion
// ---------------------------------------------------------------------------

const RULE_BASED_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bHA\b/gi, replacement: "Home Assistant" },
  { pattern: /\bVM\b/gi, replacement: "virtual machine" },
  { pattern: /\bDB\b/gi, replacement: "database" },
  { pattern: /\bAPI\b/gi, replacement: "application programming interface" },
  { pattern: /\bconfig\b/gi, replacement: "configuration" },
  { pattern: /\bsettings\b/gi, replacement: "configuration" },
  { pattern: /\bauth\b/gi, replacement: "authentication" },
  { pattern: /\bcreds\b/gi, replacement: "credentials" },
  { pattern: /\brepo\b/gi, replacement: "repository" },
  { pattern: /\bdocs\b/gi, replacement: "documentation" },
  { pattern: /\benv\b/gi, replacement: "environment" },
  { pattern: /\bsvc\b/gi, replacement: "service" },
];

export function generateRuleBasedAlias(query: string): string | null {
  if (!query.trim()) return null;
  let alias = query;
  for (const { pattern, replacement } of RULE_BASED_REPLACEMENTS) {
    alias = alias.replace(pattern, replacement);
  }
  alias = alias.replace(/\s+/g, " ").trim();
  if (!alias) return null;
  if (alias.toLowerCase() === query.trim().toLowerCase()) return null;
  return alias;
}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

/** Minimal LRU cache backed by a Map (insertion-order eviction). */
class LRUCache<K, V> {
  private readonly cache: Map<K, V>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.cache = new Map();
    this.capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    // Refresh: delete and re-insert to move to end (most-recently-used).
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict least-recently-used (first inserted key).
      const oldest = this.cache.keys().next().value as K;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const EXPANSION_PROMPT_TEMPLATE = `Given this search query: '{query}'{contextLine}

Generate 3-5 alternative search queries that would find the same information using different vocabulary, synonyms, or phrasing. Focus on semantic equivalents — not just rephrasing, but different angles a person might use to search for the same content.

Return ONLY a JSON array of strings, no other text. Example: ["alternative one", "alternative two", "alternative three"]`;

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse a JSON array of strings from an LLM response.
 * Handles responses that wrap the JSON in prose or code fences.
 * Tries every [...] substring so that arrays containing literal "]" in string
 * values (e.g. ["query about [topic]"]) parse correctly, and prose after the
 * array does not get included (unlike a single greedy match).
 */
export function parseExpansionsFromResponse(response: string, maxVariants: number): string[] {
  return extractJsonArray(response)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, maxVariants);
}

// ---------------------------------------------------------------------------
// QueryExpander
// ---------------------------------------------------------------------------

/**
 * Expands a search query into multiple variant queries via LLM.
 * Results are memoized in an LRU cache to avoid redundant LLM calls.
 */
export class QueryExpander {
  private readonly cache: LRUCache<string, string[]>;

  constructor(
    private readonly config: QueryExpansionConfig,
    private readonly openai: OpenAI,
  ) {
    this.cache = new LRUCache(config.cacheSize);
  }

  getMode(): "always" | "conditional" | "off" {
    if (!this.config.enabled) return "off";
    return this.config.mode ?? "always";
  }

  getThreshold(): number {
    return this.config.threshold ?? 0.03;
  }

  getRuleBasedAlias(query: string): string | null {
    return generateRuleBasedAlias(query);
  }

  /**
   * Expand a query into multiple alternative queries.
   *
   * @returns Array starting with the original query, followed by LLM-generated variants.
   *   On any failure or when disabled, returns [query] (original only).
   */
  async expandQuery(query: string, context?: string): Promise<string[]> {
    if (this.getMode() === "off") return [query];
    if (!query.trim()) return [query];

    const cacheKey = context ? `${query}\x00${context}` : query;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const contextLine = context
        ? `\nContext: ${context.slice(0, 300)}`
        : "";
      const prompt = EXPANSION_PROMPT_TEMPLATE
        .replace("{query}", () => query)
        .replace("{contextLine}", () => contextLine);

      const model = this.config.model ?? "openai/gpt-4.1-nano";

      const response = await chatComplete({
        model,
        content: prompt,
        temperature: 0.7,
        maxTokens: 300,
        openai: this.openai,
        timeoutMs: this.config.timeoutMs,
      });

      const variants = parseExpansionsFromResponse(response, this.config.maxVariants);
      // Deduplicate: remove variants identical to the original query.
      const filtered = variants.filter(
        (v) => v.toLowerCase() !== query.toLowerCase(),
      );

      const result = [query, ...filtered];
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      // Graceful degradation — any LLM failure returns original query only.
      // Log would go here if logger was passed in; for now, silently degrade.
      void err;
      return [query];
    }
  }

  /** Number of entries currently in the cache (for testing). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Clear the memoization cache (for testing). */
  clearCache(): void {
    this.cache.clear();
  }
}
