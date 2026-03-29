/**
 * Continuous Verification Service (Issue #164).
 *
 * Periodically re-verifies facts in the Verification Store against recent
 * knowledge to catch staleness proactively. Designed to be triggered
 * externally (cron, heartbeat, lifecycle hook) rather than running as a
 * background timer.
 */

import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import type { VerificationStore, VerifiedFact } from "./verification-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VerificationOutcome = "CONFIRMED" | "STALE" | "UNCERTAIN";

export interface VerificationCycleResult {
  checked: number;
  confirmed: number;
  stale: number;
  uncertain: number;
  errors: number;
}

interface ContinuousVerifierOptions {
  /** Days between verification cycle runs (default: 30). */
  cycleDays?: number;
  /** Model to use for LLM verification calls (default: 'openai/gpt-4.1-nano'). */
  verificationModel?: string;
  /** Per-fact LLM timeout in ms (default: 15000). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt for re-verifying a single fact.
 * Public for testing.
 */
export function buildVerificationPrompt(factText: string, entity: string, recentFacts: string[]): string {
  const recentSection =
    recentFacts.length > 0 ? recentFacts.map((f, i) => `${i + 1}. ${f}`).join("\n") : "(no recent facts available)";

  return `You are a fact-verification assistant. Determine whether the following verified fact is still accurate based on recent knowledge.\n\nVerified fact: ${factText}\n\nRecent knowledge about "${entity}":\n${recentSection}\n\nIs this still accurate based on recent knowledge?\nAnswer with exactly one of: CONFIRMED, STALE, or UNCERTAIN, followed by a brief reason.\nExample: "CONFIRMED – the IP address is still in use"\nExample: "STALE – the server was decommissioned last month"\nExample: "UNCERTAIN – no recent information available"`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response into one of the three outcome labels.
 * Uses word-boundary checks and excludes negations (e.g. "NOT CONFIRMED", "UNCONFIRMED")
 * so that responses like "UNCONFIRMED" are not misclassified as CONFIRMED.
 * Falls back to UNCERTAIN for unrecognised responses.
 */
export function parseVerificationOutcome(response: string): VerificationOutcome {
  const trimmed = response.trim();
  if (/\bCONFIRMED\b/i.test(trimmed) && !/\bNOT\s+CONFIRMED\b/i.test(trimmed) && !/\bUNCONFIRMED\b/i.test(trimmed)) {
    return "CONFIRMED";
  }
  if (/\bSTALE\b/i.test(trimmed)) return "STALE";
  return "UNCERTAIN";
}

// ---------------------------------------------------------------------------
// ContinuousVerifier
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_TIMEOUT_MS = 15_000;
const RECENT_FACTS_DAYS = 90;
// Confidence assigned to facts the LLM determines are stale. Kept below 0.3
// so that natural decay cycles will eventually remove them, while still
// preventing immediate deletion (threshold is < 0.1). Previously 0.5, which
// was misleadingly high — stale facts should not appear reliable in recall.
const STALE_CONFIDENCE = 0.2;

export class ContinuousVerifier {
  private readonly store: VerificationStore;
  private readonly factsDb: FactsDB;
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cycleDays: number | undefined;
  private lastRunDate: number | null = null;

  constructor(store: VerificationStore, factsDb: FactsDB, openai: OpenAI, options?: ContinuousVerifierOptions) {
    this.store = store;
    this.factsDb = factsDb;
    this.openai = openai;
    this.model = options?.verificationModel ?? DEFAULT_MODEL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cycleDays = options?.cycleDays;
  }

  /**
   * Internal: call the LLM and return the parsed outcome. Can throw on LLM failure.
   * Use verifyFact() for the public, error-safe interface.
   */
  private async _callLLM(factText: string, entity: string, recentFacts: string[]): Promise<VerificationOutcome> {
    const prompt = buildVerificationPrompt(factText, entity, recentFacts);
    const response = await chatComplete({
      model: this.model,
      content: prompt,
      temperature: 0,
      maxTokens: 256,
      openai: this.openai,
      timeoutMs: this.timeoutMs,
    });
    return parseVerificationOutcome(response);
  }

  /**
   * Verify a single fact against recent knowledge.
   * Returns the outcome or UNCERTAIN on any timeout/error.
   */
  async verifyFact(verifiedFact: VerifiedFact, recentFacts: string[]): Promise<VerificationOutcome> {
    // Determine entity label: prefer the entity from FactsDB, fall back to factId.
    const underlying = this.factsDb.getById(verifiedFact.factId);
    const entity = underlying?.entity ?? verifiedFact.factId;
    try {
      return await this._callLLM(verifiedFact.canonicalText, entity, recentFacts);
    } catch {
      return "UNCERTAIN";
    }
  }

  /**
   * Run a full verification cycle on all facts currently due for re-verification.
   *
   * For each due fact:
   * - Fetches recent (last 90 days) facts about the same entity from FactsDB.
   * - Asks the LLM whether the fact is still accurate.
   * - CONFIRMED → bumps verified_at and next_verification in the store.
   * - STALE     → sets confidence to 0.5 and tags the underlying fact 'needs-verification'.
   * - UNCERTAIN → tags the underlying fact 'review-needed'.
   * - Errors are counted but do not abort the cycle.
   */
  async runCycle(): Promise<VerificationCycleResult> {
    const result: VerificationCycleResult = {
      checked: 0,
      confirmed: 0,
      stale: 0,
      uncertain: 0,
      errors: 0,
    };

    if (this.cycleDays !== undefined && this.lastRunDate !== null) {
      const elapsedDays = (Date.now() - this.lastRunDate) / (24 * 60 * 60 * 1000);
      if (elapsedDays < this.cycleDays) return result;
    }

    let due: VerifiedFact[];
    try {
      due = this.store.listDueForReverification();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "continuous-verifier",
        operation: "listDueForReverification",
      });
      result.errors++;
      return result;
    }

    const recentEntries = this.factsDb.getRecentFacts(RECENT_FACTS_DAYS);
    const recentByEntity = new Map<string, string[]>();
    for (const e of recentEntries) {
      const entity = e.entity?.toLowerCase() ?? "";
      if (!recentByEntity.has(entity)) recentByEntity.set(entity, []);
      recentByEntity.get(entity)?.push(e.text);
    }

    for (const fact of due) {
      result.checked++;
      try {
        const underlying = this.factsDb.getById(fact.factId);
        const entity = underlying?.entity ?? null;
        const entityKey = entity?.toLowerCase() ?? "";
        const recentFacts = recentByEntity.get(entityKey) ?? [];

        let outcome: VerificationOutcome;
        try {
          outcome = await this._callLLM(fact.canonicalText, entity ?? fact.factId, recentFacts);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "continuous-verifier",
            operation: "verify-fact",
            metadata: { factId: fact.factId },
          });
          result.errors++;
          outcome = "UNCERTAIN";
        }

        if (outcome === "CONFIRMED") {
          this.store.update(fact.id, fact.canonicalText, "system");
          result.confirmed++;
        } else if (outcome === "STALE") {
          if (underlying) {
            this.factsDb.setConfidenceTo(underlying.id, STALE_CONFIDENCE);
            this.factsDb.addTag(underlying.id, "needs-verification");
          }
          result.stale++;
        } else {
          if (underlying) {
            this.factsDb.addTag(underlying.id, "review-needed");
          }
          result.uncertain++;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "continuous-verifier",
          operation: "runCycle-per-fact",
          metadata: { factId: fact.factId },
        });
        result.errors++;
      }
    }

    this.lastRunDate = Date.now();
    return result;
  }
}

// ---------------------------------------------------------------------------
// Convenience export for lifecycle hooks / cron triggers
// ---------------------------------------------------------------------------

/**
 * Run a verification cycle and return the result summary.
 * Suitable for calling from plugin lifecycle hooks or external cron jobs.
 */
export async function runVerificationCycle(
  store: VerificationStore,
  factsDb: FactsDB,
  openai: OpenAI,
  options?: ContinuousVerifierOptions,
): Promise<VerificationCycleResult> {
  const verifier = new ContinuousVerifier(store, factsDb, openai, options);
  return verifier.runCycle();
}
