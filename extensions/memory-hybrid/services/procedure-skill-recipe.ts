/**
 * Bounded, sanitized recipe.json for procedure skill sidecars (issue #1540).
 */

import {
  MAX_RECIPE_JSON_BYTES,
  MAX_RECIPE_STEPS_IN_SIDECAR,
  MAX_STEP_SUMMARY_CHARS,
} from "../config/skill-size-limits.js";
import { redactAutopilotValue } from "./pending-autopilot/redaction.js";
import { sanitizeRecipePromptInjection, scanRecipeForPromptInjection } from "./skill-prompt-injection.js";

const HIGH_RISK_TOOLS = new Set([
  "message",
  "email",
  "mail",
  "slack",
  "telegram",
  "discord",
  "sessions_spawn",
  "write",
  "edit",
  "bash",
  "shell",
  "exec",
]);

const SECRET_ARG_KEYS = new Set([
  "apikey",
  "api_key",
  "password",
  "token",
  "secret",
  "authorization",
  "bearer",
  "oauth",
  "access_token",
  "refresh_token",
  "client_secret",
  "credentials",
  "auth",
]);

type RecipeStep = Record<string, unknown>;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return `${value.slice(0, lo)}…`;
}

function sanitizeStep(step: unknown, index: number): RecipeStep {
  if (!step || typeof step !== "object") {
    return { tool: "step", summary: `Step ${index + 1}` };
  }
  const s = step as RecipeStep;
  const tool = typeof s.tool === "string" ? s.tool : "step";
  const out: RecipeStep = { tool };
  if (typeof s.summary === "string") {
    out.summary = truncateUtf8(s.summary, MAX_STEP_SUMMARY_CHARS);
  }
  if (HIGH_RISK_TOOLS.has(tool.toLowerCase()) && s.args && typeof s.args === "object") {
    out.args = { redacted: true, note: "high-risk tool args omitted from sidecar" };
  } else if (s.args && typeof s.args === "object") {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.args as Record<string, unknown>)) {
      if (SECRET_ARG_KEYS.has(k.toLowerCase())) continue;
      if (typeof v === "string") {
        safe[k] = truncateUtf8(v, 200);
      } else if (typeof v !== "object" || v === null) {
        safe[k] = v;
      }
    }
    if (Object.keys(safe).length > 0) out.args = safe;
  }
  return out;
}

export type SummarizedRecipe = {
  recipe: unknown;
  recipeJson: string;
  omittedSteps: number;
  originalStepCount: number;
  byteLength: number;
  withinCap: boolean;
  /** Prompt-injection markers detected in the *original* recipe (pre-sanitization). */
  injectionHits: Array<{ name: string; severity: "hard" | "soft"; sample: string }>;
  /** True when the source recipe contained a hard-severity injection marker. */
  hasHardInjection: boolean;
};

/**
 * Summarize recipe for storage: cap steps, redact, enforce UTF-8 byte budget.
 */
export function summarizeRecipeForSidecar(rawRecipe: unknown): SummarizedRecipe {
  const injectionScan = scanRecipeForPromptInjection(rawRecipe);
  const sanitizedRaw = sanitizeRecipePromptInjection(rawRecipe);
  const redacted = redactAutopilotValue(sanitizedRaw);
  const originalStepCount = Array.isArray(redacted) ? redacted.length : 0;
  let steps: unknown[] = Array.isArray(redacted) ? redacted : [];
  let omittedSteps = 0;
  if (steps.length > MAX_RECIPE_STEPS_IN_SIDECAR) {
    omittedSteps = steps.length - MAX_RECIPE_STEPS_IN_SIDECAR;
    steps = steps.slice(0, MAX_RECIPE_STEPS_IN_SIDECAR);
  }
  const sanitized = steps.map((step, i) => sanitizeStep(step, i));
  const payload: Record<string, unknown> = {
    steps: sanitized,
    omittedSteps,
    originalStepCount,
  };
  if (omittedSteps > 0) {
    payload.note = "Long procedure collapsed; see SKILL.md workflow and references/workflow.md when present.";
  }
  let recipeJson = `${JSON.stringify(payload, null, 2)}\n`;
  let byteLength = Buffer.byteLength(recipeJson, "utf8");
  if (byteLength > MAX_RECIPE_JSON_BYTES) {
    const minimal = {
      steps: sanitized.slice(0, Math.min(10, sanitized.length)),
      omittedSteps: omittedSteps + Math.max(0, sanitized.length - 10),
      originalStepCount,
      truncated: true,
    };
    recipeJson = `${JSON.stringify(minimal, null, 2)}\n`;
    byteLength = Buffer.byteLength(recipeJson, "utf8");
    if (byteLength > MAX_RECIPE_JSON_BYTES) {
      recipeJson = `${JSON.stringify({ originalStepCount, omittedSteps, truncated: true }, null, 2)}\n`;
      byteLength = Buffer.byteLength(recipeJson, "utf8");
    }
  }
  return {
    recipe: payload,
    recipeJson,
    omittedSteps,
    originalStepCount,
    byteLength,
    withinCap: byteLength <= MAX_RECIPE_JSON_BYTES,
    injectionHits: injectionScan.hits,
    hasHardInjection: injectionScan.hasHardInjection,
  };
}
