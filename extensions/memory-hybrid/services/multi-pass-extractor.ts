/**
 * Multi-Pass Extraction Service (Issue #166).
 *
 * Implements a three-pass extraction pipeline over a conversation transcript:
 *
 * Pass 1 — Explicit extraction (cheap/nano model):
 *   Extracts clearly-stated facts ("I prefer X", "use library Y").
 *   Same prompting strategy as the current auto-capture pipeline.
 *
 * Pass 2 — Implicit extraction (mid-tier model):
 *   Extracts implied preferences, corrections, and contextual signals
 *   that Pass 1 would miss ("actually, let's try Z instead").
 *
 * Pass 3 — Verification against transcript (nano model):
 *   Each candidate fact (from Passes 1 + 2) is checked against the
 *   original transcript and labelled CONFIRMED, UNCERTAIN, or REJECTED.
 *   CONFIRMED → keep at original confidence
 *   UNCERTAIN → set confidence to 0.4 and add 'needs-review' tag
 *   REJECTED  → exclude from output
 *
 * The service is stateless and does NOT write to the database — callers are
 * responsible for persisting the returned facts.
 */

import type OpenAI from "openai";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verdict from Pass 3 verification. */
type ExtractionVerdict = "CONFIRMED" | "UNCERTAIN" | "REJECTED";

/** A candidate fact produced by Pass 1 or Pass 2. */
export interface CandidateFact {
  text: string;
  category: string;
  importance: number;
  /** Which extraction pass produced this candidate (1 = explicit, 2 = implicit). */
  pass: 1 | 2;
}

/** A fact that survived Pass 3 verification (or when verificationPass is disabled). Named ExtractedFact to avoid collision with verification-store.VerifiedFact. */
interface ExtractedFact {
  text: string;
  category: string;
  importance: number;
  /** Confidence after verification: original when CONFIRMED, 0.4 when UNCERTAIN. */
  confidence: number;
  /** Tags added during verification (e.g. "needs-review" when UNCERTAIN). */
  tags: string[];
  /** Verdict from Pass 3, or undefined when verificationPass is disabled. */
  verdict?: ExtractionVerdict;
  /** Which extraction pass produced this fact. */
  pass: 1 | 2;
}

interface MultiPassExtractionResult {
  facts: ExtractedFact[];
  /** Total candidates from Pass 1. */
  explicitCount: number;
  /** Total candidates from Pass 2. */
  implicitCount: number;
  /** Facts rejected by Pass 3 (only meaningful when verificationPass is true). */
  rejectedCount: number;
}

interface MultiPassExtractorOptions {
  /** Model for Pass 1 explicit extraction (default: 'openai/gpt-4.1-nano'). */
  extractionModel?: string;
  /** Model for Pass 2 implicit extraction (default: 'openai/gpt-4.1-mini'). */
  implicitModel?: string;
  /** Model for Pass 3 verification (default: 'openai/gpt-4.1-nano'). */
  verificationModel?: string;
  /** Enable Pass 2 implicit extraction (default: true). */
  extractionPasses?: boolean;
  /** Enable Pass 3 verification (default: false). */
  verificationPass?: boolean;
  /** Per-LLM-call timeout in ms (default: 15000). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const EXTRACTION_CATEGORIES = "preference, fact, decision, entity, pattern, rule, other";

/** Valid category set for normalization (matches DEFAULT_MEMORY_CATEGORIES). */
const VALID_CATEGORIES = new Set<string>(["preference", "fact", "decision", "entity", "pattern", "rule", "other"]);

/** Normalize LLM category to a valid default; "preferences" -> "preference", unknown -> "other". */
function normalizeCategory(category: string): string {
  const lower = category.trim().toLowerCase();
  if (lower === "preferences") return "preference";
  if (VALID_CATEGORIES.has(lower)) return lower;
  return "other";
}

const PASS1_SYSTEM_PROMPT = `You are a fact extractor. Extract clearly and explicitly stated facts from the transcript. Return a JSON array of objects with keys: text (string), category (string), importance (0.0–1.0). Categories: ${EXTRACTION_CATEGORIES}. Only include facts explicitly stated, not implied or inferred. Return [] if no clear facts are found.`;

const PASS2_SYSTEM_PROMPT = `You are an implicit preference analyst. Extract implied preferences, corrections, and contextual signals from the transcript that were NOT explicitly stated but can be reliably inferred. Focus on: preference changes ("actually let\'s try X"), implicit corrections, unstated constraints, workflow signals. Return a JSON array of objects with keys: text (string), category (string), importance (0.0–1.0). Categories: ${EXTRACTION_CATEGORIES}. Return [] if no implicit facts can be reliably inferred.`;

const PASS3_SYSTEM_PROMPT =
  "You are a fact verifier. Given a candidate fact and the original conversation transcript, " +
  "determine whether the fact is supported by the transcript. " +
  "Answer with exactly one of: CONFIRMED, UNCERTAIN, or REJECTED. " +
  "CONFIRMED = the transcript clearly supports this fact. " +
  "UNCERTAIN = the transcript partially supports this or is ambiguous. " +
  "REJECTED = the transcript contradicts this or provides no basis for it.";

// ---------------------------------------------------------------------------
// Default models
// ---------------------------------------------------------------------------

const DEFAULT_EXTRACTION_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_IMPLICIT_MODEL = "openai/gpt-4.1-mini";
const DEFAULT_VERIFICATION_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Prompt builders (exported for testing)
// ---------------------------------------------------------------------------

/** Build the Pass 1 user prompt for explicit extraction. */
export function buildPass1Prompt(transcript: string): string {
  return `Extract explicitly stated facts from this conversation transcript:\n\n${transcript}`;
}

/** Build the Pass 2 user prompt for implicit extraction. */
export function buildPass2Prompt(transcript: string): string {
  return `Identify implied preferences, corrections, and contextual signals from this conversation transcript:\n\n${transcript}`;
}

/** Build the Pass 3 verification prompt for a single candidate fact. */
export function buildVerificationPrompt(fact: CandidateFact, transcript: string): string {
  return `Candidate fact: "${fact.text}"\n\nOriginal transcript:\n${transcript}\n\nIs this fact supported by the transcript? Answer with CONFIRMED, UNCERTAIN, or REJECTED.`;
}

// ---------------------------------------------------------------------------
// Response parsers (exported for testing)
// ---------------------------------------------------------------------------

/** Parse the LLM JSON response from Pass 1 or Pass 2 into candidate facts. */
export function parseCandidateFacts(response: string, pass: 1 | 2): CandidateFact[] {
  // Strip markdown code fences if present
  const cleaned = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const facts: CandidateFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text !== "string" || obj.text.trim().length === 0) continue;
    const rawCategory = typeof obj.category === "string" ? obj.category : "other";
    const category = normalizeCategory(rawCategory);
    const importance =
      typeof obj.importance === "number" && obj.importance >= 0 && obj.importance <= 1 ? obj.importance : 0.7;
    facts.push({ text: obj.text.trim(), category, importance, pass });
  }
  return facts;
}

/**
 * Parse the Pass 3 LLM verdict response. Defaults to UNCERTAIN for unrecognised responses.
 * Checks REJECTED before CONFIRMED and uses word-boundary + negation exclusion so that
 * "REJECTED because the transcript does not CONFIRM this" returns REJECTED, and
 * "NOT CONFIRMED" does not return CONFIRMED.
 */
export function parseVerdict(response: string): ExtractionVerdict {
  const trimmed = response.trim();
  if (/\bREJECTED\b/i.test(trimmed)) return "REJECTED";
  if (/\bCONFIRMED\b/i.test(trimmed) && !/\bNOT\s+CONFIRMED\b/i.test(trimmed) && !/\bUNCONFIRMED\b/i.test(trimmed)) {
    return "CONFIRMED";
  }
  return "UNCERTAIN";
}

// ---------------------------------------------------------------------------
// MultiPassExtractor
// ---------------------------------------------------------------------------

const UNCERTAIN_CONFIDENCE = 0.4;
const UNCERTAIN_TAG = "needs-review";

export class MultiPassExtractor {
  private readonly openai: OpenAI;
  private readonly extractionModel: string;
  private readonly implicitModel: string;
  private readonly verificationModel: string;
  private readonly verificationPass: boolean;
  private readonly extractionPasses: boolean;
  private readonly timeoutMs: number;

  constructor(openai: OpenAI, options?: MultiPassExtractorOptions) {
    this.openai = openai;
    this.extractionModel = options?.extractionModel ?? DEFAULT_EXTRACTION_MODEL;
    this.implicitModel = options?.implicitModel ?? DEFAULT_IMPLICIT_MODEL;
    this.verificationModel = options?.verificationModel ?? DEFAULT_VERIFICATION_MODEL;
    this.extractionPasses = options?.extractionPasses ?? true;
    this.verificationPass = options?.verificationPass ?? false;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Run Pass 1 explicit extraction. Returns candidates or [] on error. */
  async runPass1(transcript: string): Promise<CandidateFact[]> {
    try {
      const response = await chatComplete({
        model: this.extractionModel,
        content: `${PASS1_SYSTEM_PROMPT}\n\n${buildPass1Prompt(transcript)}`,
        temperature: 0,
        openai: this.openai,
        timeoutMs: this.timeoutMs,
      });
      return parseCandidateFacts(response, 1);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "multi-pass-extractor",
        operation: "runPass1",
      });
      return [];
    }
  }

  /** Run Pass 2 implicit extraction. Returns candidates or [] on error. */
  async runPass2(transcript: string): Promise<CandidateFact[]> {
    try {
      const response = await chatComplete({
        model: this.implicitModel,
        content: `${PASS2_SYSTEM_PROMPT}\n\n${buildPass2Prompt(transcript)}`,
        temperature: 0.2,
        openai: this.openai,
        timeoutMs: this.timeoutMs,
      });
      return parseCandidateFacts(response, 2);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "multi-pass-extractor",
        operation: "runPass2",
      });
      return [];
    }
  }

  /** Run Pass 3 verification on a single candidate. Returns UNCERTAIN on error. */
  async verifyCandidate(candidate: CandidateFact, transcript: string): Promise<ExtractionVerdict> {
    try {
      const response = await chatComplete({
        model: this.verificationModel,
        content: `${PASS3_SYSTEM_PROMPT}\n\n${buildVerificationPrompt(candidate, transcript)}`,
        temperature: 0,
        openai: this.openai,
        timeoutMs: this.timeoutMs,
      });
      return parseVerdict(response);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "multi-pass-extractor",
        operation: "verifyCandidate",
      });
      return "UNCERTAIN";
    }
  }

  /**
   * Run the full multi-pass extraction pipeline on a transcript.
   *
   * When extractionPasses=false: only Pass 1 runs.
   * When verificationPass=false: all candidates from Passes 1 + 2 are kept as CONFIRMED.
   * When verificationPass=true: each candidate is checked and REJECTED facts are excluded.
   */
  async extract(transcript: string): Promise<MultiPassExtractionResult> {
    // Pass 1: Explicit extraction
    const pass1Candidates = await this.runPass1(transcript);

    // Pass 2: Implicit extraction (when enabled)
    let pass2Candidates: CandidateFact[] = [];
    if (this.extractionPasses) {
      pass2Candidates = await this.runPass2(transcript);
    }

    const allCandidates = [...pass1Candidates, ...pass2Candidates];

    let facts: ExtractedFact[];
    let rejectedCount = 0;

    if (this.verificationPass && allCandidates.length > 0) {
      // Pass 3: Verify each candidate against the transcript
      facts = [];
      for (const candidate of allCandidates) {
        const verdict = await this.verifyCandidate(candidate, transcript);
        if (verdict === "REJECTED") {
          rejectedCount++;
          continue;
        }
        facts.push({
          text: candidate.text,
          category: candidate.category,
          importance: candidate.importance,
          confidence: verdict === "CONFIRMED" ? candidate.importance : UNCERTAIN_CONFIDENCE,
          tags: verdict === "UNCERTAIN" ? [UNCERTAIN_TAG] : [],
          verdict,
          pass: candidate.pass,
        });
      }
    } else {
      // No verification: treat all candidates as CONFIRMED
      facts = allCandidates.map((c) => ({
        text: c.text,
        category: c.category,
        importance: c.importance,
        confidence: c.importance,
        tags: [],
        verdict: undefined,
        pass: c.pass,
      }));
    }

    return {
      facts,
      explicitCount: pass1Candidates.length,
      implicitCount: pass2Candidates.length,
      rejectedCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------

/**
 * Run multi-pass extraction on a transcript.
 * Suitable for calling from lifecycle hooks or external scripts.
 */
export async function extractMultiPass(
  transcript: string,
  openai: OpenAI,
  options?: MultiPassExtractorOptions,
): Promise<MultiPassExtractionResult> {
  const extractor = new MultiPassExtractor(openai, options);
  return extractor.extract(transcript);
}
