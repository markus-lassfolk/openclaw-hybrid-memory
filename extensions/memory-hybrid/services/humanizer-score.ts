/**
 * Humanizer Style Scoring — Quality loop metric for detecting AI-writing patterns.
 * Issue #616 — Phase 1: evaluator only, no rewriting.
 *
 * Runs the `humanizer` CLI (clawhub install humanizer) against agent replies and stores
 * the score in the quality_loop memory category so memory_reflect can surface patterns.
 *
 * Scoring breakdown (from humanizer):
 *   - Pattern score (70%): explicit phrase/style detectors, vocab tiers, breadth bonuses
 *   - Uniformity score (30%): burstiness, type-token ratio, sentence-length variation
 *
 * Output stored per turn:
 *   "humanizer_score: 0.73, patterns: ['great_question','happy_to_help'], model: sonnet, skill: weather"
 */

import { spawn } from "node:child_process";
import { capturePluginError } from "./error-reporter.js";
import type { HumanizerConfig } from "../config/types/features.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Raw output from `humanizer score --json` */
export interface HumanizerRawOutput {
  score: number;
  patterns_triggered?: string[];
  category_breakdown?: Record<string, number>;
  /** Present in some humanizer builds */
  uniformity_score?: number;
  pattern_score?: number;
}

/** Parsed, validated result after calling humanizer */
export interface HumanizerResult {
  score: number;
  patternsTriggered: string[];
  categoryBreakdown: Record<string, number>;
  rawOutput: HumanizerRawOutput;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse raw JSON output from `humanizer score --json`.
 * Returns null when output is empty, non-JSON, or missing required fields.
 */
export function parseHumanizerOutput(raw: string): HumanizerResult | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.score !== "number") return null;

    const score = Math.max(0, Math.min(1, obj.score));

    const patternsTriggered: string[] = [];
    if (Array.isArray(obj.patterns_triggered)) {
      for (const p of obj.patterns_triggered) {
        if (typeof p === "string" && p.trim()) {
          patternsTriggered.push(p.trim());
        }
      }
    }

    const categoryBreakdown: Record<string, number> = {};
    if (
      typeof obj.category_breakdown === "object" &&
      obj.category_breakdown !== null &&
      !Array.isArray(obj.category_breakdown)
    ) {
      for (const [k, v] of Object.entries(obj.category_breakdown as Record<string, unknown>)) {
        if (typeof v === "number") {
          categoryBreakdown[k] = v;
        }
      }
    }

    const rawOutput: HumanizerRawOutput = {
      score: obj.score,
      patterns_triggered: patternsTriggered,
      category_breakdown: Object.keys(categoryBreakdown).length > 0 ? categoryBreakdown : undefined,
    };
    if (typeof obj.uniformity_score === "number") rawOutput.uniformity_score = obj.uniformity_score;
    if (typeof obj.pattern_score === "number") rawOutput.pattern_score = obj.pattern_score;

    return { score, patternsTriggered, categoryBreakdown, rawOutput };
  } catch {
    return null;
  }
}

/**
 * Format a quality_loop memory entry from a humanizer result.
 * Produces a compact, searchable string suitable for memory_store and later reflect queries.
 */
export function formatQualityLoopEntry(
  result: HumanizerResult,
  opts: {
    modelTag?: string;
    skillTag?: string;
  } = {},
): string {
  const parts: string[] = [`humanizer_score: ${result.score.toFixed(2)}`];

  if (result.patternsTriggered.length > 0) {
    // Limit to first 5 patterns to keep the fact concise
    const shown = result.patternsTriggered.slice(0, 5);
    parts.push(`patterns: [${shown.map((p) => `'${p}'`).join(", ")}]`);
  }

  if (opts.modelTag) {
    parts.push(`model: ${opts.modelTag}`);
  }

  if (opts.skillTag) {
    parts.push(`skill: ${opts.skillTag}`);
  }

  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

/**
 * Run `humanizer score --json` and return the parsed result.
 * Text is passed via stdin to avoid exposing content in process listings.
 *
 * Returns null when:
 *   - humanizer is not installed (ENOENT)
 *   - text is too short
 *   - CLI returns non-zero or unparseable output
 *
 * Never throws — all errors are captured via capturePluginError.
 */
export async function runHumanizerScore(
  text: string,
  cfg: Pick<HumanizerConfig, "bin" | "minTextLength" | "maxTextLength">,
): Promise<HumanizerResult | null> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < cfg.minTextLength) return null;

  const truncated = trimmed.length > cfg.maxTextLength ? trimmed.slice(0, cfg.maxTextLength) : trimmed;

  try {
    return await new Promise<HumanizerResult | null>((resolve, reject) => {
      const child = spawn(cfg.bin, ["score", "--json", "--stdin"], {
        timeout: 10_000,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!settled && stdout.length > 1024 * 1024) {
          settled = true;
          child.kill();
          reject(new Error("stdout exceeded 1 MB"));
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve(parseHumanizerOutput(stdout));
        } else {
          reject(new Error(`humanizer exited with code ${code}: ${stderr}`));
        }
      });

      child.stdin.on("error", (e) => {
        // EPIPE is expected when the process exits before consuming all input
        if ((e as NodeJS.ErrnoException).code !== "EPIPE") {
          capturePluginError(e, { operation: "humanizer-stdin-write", subsystem: "humanizer", severity: "info" });
        }
      });

      child.stdin.write(truncated);
      child.stdin.end();
    });
  } catch (err) {
    const asErr = err instanceof Error ? err : new Error(String(err));
    if ((asErr as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    capturePluginError(asErr, {
      operation: "humanizer-score",
      subsystem: "humanizer",
      severity: "info",
    });
    return null;
  }
}
