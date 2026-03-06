/**
 * Contextual Variant Generator (Issue #159).
 *
 * At fact storage time, generate 1-2 contextual expansions via LLM and embed
 * them alongside the canonical text. This bridges semantic gaps — a fact about
 * "HA runs on Proxmox VM 100 at 192.168.1.212" also gets a variant like
 * "smart home server infrastructure" so it matches queries from different angles.
 *
 * Key design:
 * - Variant generation is ASYNC and non-blocking (queue-based).
 * - Graceful degradation: LLM failures return empty arrays, fact still stored.
 * - Rate limiting via sliding window on call timestamps.
 * - Category filtering: optionally restrict to specific categories.
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import type { ContextualVariantsConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const VARIANT_PROMPT_TEMPLATE = `Given this memory fact:
"{text}"
Category: {category}

Generate {count} brief alternative phrasings that capture the same meaning using different vocabulary or framing. Each phrasing should be a single concise sentence that someone might use to search for this information.

Return ONLY a JSON array of strings, no other text. Example: ["phrasing one", "phrasing two"]`;

// ---------------------------------------------------------------------------
// ContextualVariantGenerator
// ---------------------------------------------------------------------------

/**
 * Generates contextual expansions for a fact text via LLM.
 * Implements rate limiting and graceful degradation.
 */
export class ContextualVariantGenerator {
  /** Sliding-window call timestamps for rate limiting (ms epoch). */
  private callTimestamps: number[] = [];

  constructor(
    private readonly config: ContextualVariantsConfig,
    private readonly openai: OpenAI,
  ) {}

  /**
   * Generate 0-N contextual variant phrasings for the given fact text.
   * Returns empty array when disabled, rate-limited, or on LLM error.
   */
  async generateVariants(text: string, category: string): Promise<string[]> {
    if (!this.config.enabled) return [];

    // Category filter: skip if categories list is set and this category is not in it.
    if (
      Array.isArray(this.config.categories) &&
      this.config.categories.length > 0 &&
      !this.config.categories.includes(category)
    ) {
      return [];
    }

    // Rate limiting: sliding window of maxPerMinute calls per 60s.
    const now = Date.now();
    const windowMs = 60_000;
    this.callTimestamps = this.callTimestamps.filter((t) => now - t < windowMs);
    if (this.callTimestamps.length >= this.config.maxPerMinute) {
      return [];
    }
    this.callTimestamps.push(now);

    const count = Math.max(1, this.config.maxVariantsPerFact);
    const prompt = VARIANT_PROMPT_TEMPLATE.replace("{text}", () => text)
      .replace("{category}", () => category)
      .replace("{count}", () => String(count));

    const model = this.config.model ?? "openai/gpt-4.1-nano";

    try {
      const response = await chatComplete({
        model,
        content: prompt,
        temperature: 0.7,
        maxTokens: 300,
        openai: this.openai,
        timeoutMs: 15_000,
      });

      return parseVariantsFromResponse(response, this.config.maxVariantsPerFact);
    } catch (err) {
      // Graceful degradation — log but never throw (fact already stored)
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "contextual-variants",
        operation: "generateVariants",
      });
      return [];
    }
  }

  /** Expose call count in window for testing rate limiting. */
  get callsInWindow(): number {
    const now = Date.now();
    return this.callTimestamps.filter((t) => now - t < 60_000).length;
  }

  /** Reset call timestamps (for testing). */
  _resetRateLimit(): void {
    this.callTimestamps = [];
  }
}

/**
 * Parse a JSON array of strings from an LLM response.
 * Handles responses that wrap the JSON in prose or code fences.
 * Tries every [...] substring (same approach as query-expander) so that arrays
 * containing literal "]" in string values parse correctly.
 */
export function parseVariantsFromResponse(response: string, maxVariants: number): string[] {
  const candidates: string[] = [];
  let start = response.indexOf("[");
  while (start !== -1) {
    let end = response.indexOf("]", start + 1);
    while (end !== -1) {
      candidates.push(response.slice(start, end + 1));
      end = response.indexOf("]", end + 1);
    }
    start = response.indexOf("[", start + 1);
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    return parsed
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, maxVariants);
  }
  return [];
}

// ---------------------------------------------------------------------------
// VariantGenerationQueue
// ---------------------------------------------------------------------------

/** An item waiting for variant generation. */
export interface VariantQueueItem {
  factId: string;
  text: string;
  category: string;
}

/**
 * Async background queue for variant generation.
 * Processes in batches of 5, rate-limited by the generator.
 * Enqueue returns immediately; processing happens in the background.
 */
export class VariantGenerationQueue {
  private queue: VariantQueueItem[] = [];
  private processing = false;
  private readonly batchSize = 5;

  constructor(
    private readonly generator: ContextualVariantGenerator,
    /** Called with generated variants for a fact. Should store them in DB. */
    private readonly onVariantsGenerated: (factId: string, variants: string[]) => Promise<void>,
  ) {}

  /** Add a fact to the variant generation queue. Non-blocking. */
  enqueue(item: VariantQueueItem): void {
    this.queue.push(item);
    if (!this.processing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        for (const item of batch) {
          try {
            const variants = await this.generator.generateVariants(item.text, item.category);
            if (variants.length > 0) {
              await this.onVariantsGenerated(item.factId, variants);
            }
          } catch {
            // Graceful degradation — skip this item
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Number of items waiting to be processed. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Whether the queue is currently processing. */
  get isProcessing(): boolean {
    return this.processing;
  }
}
