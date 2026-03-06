/**
 * Continuous Verification Service (Issue #164).
 *
 * Periodically re-verifies facts in the Verification Store against recent
 * knowledge to catch staleness proactively. Designed to be triggered
 * externally (cron, heartbeat, lifecycle hook) rather than running as a
 * background timer.
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import type { VerificationStore, VerifiedFact } from "./verification-store.js";
import type { FactsDB } from "../backends/facts-db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationOutcome = "CONFIRMED" | "STALE" | "UNCERTAIN";

export interface VerificationCycleResult {
  checked: number;
  confirmed: number;
  stale: number;
  uncertain: number;
  errors: number;
}

export interface ContinuousVerifierOptions {
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
export function buildVerificationPrompt(
  factText: string,
  entity: string,
  recentFacts: string[],
): string {
  const recentSection =
    recentFacts.length > 0
      ? recentFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")
      : "(no recent facts available)";

  return (
    `You are a fact-verification assistant. Determine whether the following verified fact is still accurate based on recent knowledge.\n\n` +
    `Verified fact: ${factText}\n\n` +
    `Recent knowledge about "${entity}":\n${recentSection}\n\n` +
    `Is the verified fact still accurate?\n` +
    `Answer with exactly one of: CONFIRMED, STALE, or UNCERTAIN, followed by a brief reason.\n` +
    `Example: "CONFIRMED – the IP address is still in use"\n` +
    `Example: "STALE – the server was decommissioned last month"\n` +
    `Example: "UNCERTAIN – no recent information available"`
  );
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response into one of the three outcome labels.
 * Looks for CONFIRMED / STALE / UNCERTAIN anywhere in the response (case-insensitive).
 * Falls back to UNCERTAIN for unrecognised responses.
 */
export function parseVerificationOutcome(response: string): VerificationOutcome {
  const upper = response.toUpperCase();
  if (upper.includes("CONFIRMED")) return "CONFIRMED";
  if (upper.includes("STALE")) return "STALE";
  return "UNCERTAIN";
}

// ---------------------------------------------------------------------------
// ContinuousVerifier
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_TIMEOUT_MS = 15_000;
const RECENT_FACTS_DAYS = 90;
const STALE_CONFIDENCE = 0.3;

export class ContinuousVerifier {
  private readonly store: VerificationStore;
  private readonly factsDb: FactsDB;
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    store: VerificationStore,
    factsDb: FactsDB,
    openai: OpenAI,
    options?: ContinuousVerifierOptions,
  ) {
    this.store = store;
    this.factsDb = factsDb;
    this.openai = openai;
    this.model = options?.verificationModel ?? DEFAULT_MODEL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Internal: call the LLM and return the parsed outcome. Can throw on LLM failure.
   * Use verifyFact() for the public, error-safe interface.
   */
  private async _callLLM(
    factText: string,
    entity: string,
    recentFacts: string[],
  ): Promise<VerificationOutcome> {
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
  async verifyFact(
    verifiedFact: VerifiedFact,
    recentFacts: string[],
  ): Promise<VerificationOutcome> {
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
   * - STALE     → sets confidence to 0.3 and tags the underlying fact 'needs-verification'.
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

    let due: VerifiedFact[];
    try {
      due = await this.store.listDueForReverification();
    } catch (err) {
      result.errors++;
      return result;
    }

    for (const fact of due) {
      result.checked++;
      try {
        // Gather recent facts about the same entity.
        const underlying = this.factsDb.getById(fact.factId);
        const entity = underlying?.entity ?? null;

        const recentEntries = this.factsDb.getRecentFacts(RECENT_FACTS_DAYS);
        const recentFacts = recentEntries
          .filter((e) =>
            entity !== null
              ? e.entity?.toLowerCase() === entity.toLowerCase()
              : false,
          )
          .map((e) => e.text);

        // Call LLM via private method so errors can be counted separately.
        let outcome: VerificationOutcome;
        try {
          outcome = await this._callLLM(
            fact.canonicalText,
            entity ?? fact.factId,
            recentFacts,
          );
        } catch {
          // LLM error — count it and treat the fact as UNCERTAIN.
          result.errors++;
          outcome = "UNCERTAIN";
        }

        if (outcome === "CONFIRMED") {
          // Update verified_at and next_verification by creating a new version
          // with the same text (re-attesting the existing canonical text).
          await this.store.update(fact.id, fact.canonicalText, "system");
          result.confirmed++;
        } else if (outcome === "STALE") {
          // Reduce confidence to STALE_CONFIDENCE in FactsDB.
          if (underlying) {
            this.factsDb.setConfidenceTo(underlying.id, STALE_CONFIDENCE);
            this.factsDb.addTag(underlying.id, "needs-verification");
          }
          result.stale++;
        } else {
          // UNCERTAIN — tag for review, leave confidence unchanged.
          if (underlying) {
            this.factsDb.addTag(underlying.id, "review-needed");
          }
          result.uncertain++;
        }
      } catch {
        result.errors++;
      }
    }

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
