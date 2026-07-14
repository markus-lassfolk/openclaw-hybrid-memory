/**
 * Serendipity decision policy (Issue #2119).
 *
 * Pure, deterministic triage: given a finding and the caller's effective
 * engagement level, recommend an action. No LLM — fast, testable, and aligned
 * with the guardrails (destructive/external/privacy/irreversible always ask).
 *
 * This RECOMMENDS ONLY. It never executes. The agent acts under normal approval
 * rules; nothing here expands task scope silently.
 */

import type {
  SerendipityFinding,
  SerendipityFindingType,
  SerendipitySuggestedAction,
} from "../types/serendipity-types.js";

export interface SerendipityDecision {
  action: SerendipitySuggestedAction;
  rationale: string;
  /** The effective level the decision was made at (echoed for transparency). */
  level: number;
}

/** Finding types that are safety/reliability/trust concerns. */
const SAFETY_TYPES: ReadonlySet<SerendipityFindingType> = new Set([
  "unsafe_default",
  "missing_validation",
  "packaging_defect",
]);

/** Finding types that represent leverage/process improvements. */
const IMPROVEMENT_TYPES: ReadonlySet<SerendipityFindingType> = new Set([
  "load_reduction_opportunity",
  "repeated_friction",
]);

const LOW_CONFIDENCE = 0.4;

/** Inputs the policy reads — a subset of SerendipityFinding (eases unit testing). */
export type DecidableFinding = Pick<
  SerendipityFinding,
  | "findingType"
  | "riskLevel"
  | "reversibility"
  | "adjacency"
  | "estimatedHumanLoadReduction"
  | "confidence"
  | "external"
  | "destructive"
  | "privacySensitive"
>;

export function decideSerendipityAction(finding: DecidableFinding, level: number): SerendipityDecision {
  const decide = (action: SerendipitySuggestedAction, rationale: string): SerendipityDecision => ({
    action,
    rationale,
    level,
  });

  // 1. Guardrail override — regardless of level.
  if (finding.destructive || finding.external || finding.privacySensitive) {
    return decide("ask_user", "Destructive, external, or privacy-sensitive — requires explicit human approval.");
  }
  if (finding.reversibility === "irreversible") {
    return decide("ask_user", "Irreversible change — requires explicit human approval before acting.");
  }

  const isSafety = SAFETY_TYPES.has(finding.findingType);
  const isImprovement = IMPROVEMENT_TYPES.has(finding.findingType);
  const lowConfidence = finding.confidence < LOW_CONFIDENCE;
  const reversibleEnough = finding.reversibility === "easy" || finding.reversibility === "moderate";

  // 2. Level 0 — requested-only.
  if (level < 1) {
    return isSafety
      ? decide("remember", "Level 0 (requested-only): note the safety-relevant finding, but take no action.")
      : decide("ignore", "Level 0 (requested-only): no action on adjacent findings.");
  }

  // 3. Safety findings at level >= 1 (safety serendipity).
  if (isSafety) {
    if (
      finding.riskLevel === "low" &&
      finding.reversibility === "easy" &&
      finding.adjacency === "direct" &&
      !lowConfidence
    ) {
      return decide("fix_now", "Safety issue that is low-risk, easily reversible, and directly adjacent — fix now.");
    }
    return decide("file_issue", "Safety issue not trivially auto-fixable — file it with evidence.");
  }

  // 4. Level >= 2 — adjacent cleanup and above.
  if (level >= 2) {
    // Improvement scout (level >= 3): recurring friction / load reduction → propose leverage.
    if (level >= 3 && isImprovement && finding.adjacency !== "unrelated") {
      if (finding.estimatedHumanLoadReduction === "large" || finding.riskLevel === "high") {
        return decide("create_task", "Level 3+: sizeable leverage improvement — propose a task, don't fix silently.");
      }
      return decide(
        "propose_skill",
        "Level 3+: recurring friction / load-reduction opportunity — propose a skill or wrapper.",
      );
    }

    const directLowRisk = finding.adjacency === "direct" && finding.riskLevel === "low" && reversibleEnough;
    if (directLowRisk) {
      return lowConfidence
        ? decide(
            "remember",
            "Directly adjacent and low-risk, but confidence is low — remember and verify before acting.",
          )
        : decide("fix_now", "Low-risk, reversible, directly adjacent cleanup — fix now.");
    }
    if (finding.adjacency === "direct" || finding.adjacency === "near") {
      return decide("file_issue", "Adjacent but not clearly safe to auto-fix — file it with evidence.");
    }
    // Broad / unrelated.
    if (level >= 4) {
      return decide(
        "file_issue",
        "Level 4 (steward): broad finding — file it with evidence rather than expand scope silently.",
      );
    }
    return decide("remember", "Broad or unrelated at this level — remember only.");
  }

  // 5. Level in [1, 2) — safety serendipity only; non-safety findings are just noted.
  return finding.adjacency === "direct"
    ? decide("remember", "Level 1 (safety): non-safety adjacent finding — remember for later.")
    : decide("ignore", "Level 1 (safety): non-safety and not directly adjacent — ignore.");
}

/** Short human label for a level (used in the injected policy summary). */
export function describeLevel(level: number): string {
  if (level < 1) return "requested-only";
  if (level < 2) return "safety";
  if (level < 3) return "adjacent-cleanup";
  if (level < 4) return "improvement-scout";
  return "steward";
}

/**
 * Compact, bounded policy summary injected into agent context. Communicates the
 * current level and the guardrails without becoming noisy.
 */
export function buildSerendipityPolicySummary(level: number, maxChars: number): string {
  const rounded = Number.isInteger(level) ? String(level) : level.toFixed(1);
  const behavior =
    level < 1
      ? "Do only requested work; mention blockers and serious safety issues only."
      : level < 2
        ? "Also act on immediate safety/security/data-loss/reliability issues."
        : level < 3
          ? "Also fix low-risk, reversible, directly adjacent issues; file or remember larger ones."
          : level < 4
            ? "Actively scout leverage improvements (wrappers, tests, docs); propose skills/issues, don't wander."
            : "Steward mode: proactive backlog sweeps and broader maintenance are in-bounds.";
  const line = `[serendipity] Level ${rounded} (${describeLevel(level)}). ${behavior} Ask before risky/destructive/external/privacy-sensitive actions. Optimize for reducing future human load, not creating a new garden to maintain.`;
  return line.length > maxChars ? `${line.slice(0, Math.max(0, maxChars - 1))}…` : line;
}
