/**
 * Agent tool helpers for memory_procedure_feedback (#1965–#1967).
 */
import type { FactsDB } from "../backends/facts-db.js";
import type { ProcedureEntry, ProcedureStep, ScopeFilter } from "../types/memory.js";
import { minimalRecipe } from "./procedure-extractor.js";

export type ProcedureFeedbackToolParams = {
  procedureId: string;
  success: boolean;
  context?: string;
  failedAtStep?: number;
  duration?: number;
  tags?: string[];
  registerIfMissing?: boolean;
  taskPattern?: string;
  steps?: ProcedureStep[];
  procedureType?: "positive" | "negative";
  /** Pre-resolved (already security-gated) scope filter — see buildToolScopeFilter. */
  scopeFilter?: ScopeFilter;
};

export type ProcedureFeedbackToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const NOT_FOUND_HINT = "use_memory_record_episode_or_recall_first";

export function buildProcedureNotFoundToolResult(procedureId: string): ProcedureFeedbackToolResult {
  const text = [
    `Procedure not found: \`${procedureId}\`.`,
    "This tool records feedback for an **existing** procedure (from `memory_recall_procedures` or nightly `extract-procedures`).",
    "It does not create procedures unless `registerIfMissing: true` with `taskPattern` and `steps`.",
    "For a first-run outcome without a stored procedure, use `memory_record_episode` or `memory_store`; do not retry this tool with the same id.",
  ].join(" ");
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: {
      success: false,
      error: "procedure_not_found",
      procedureId,
      hint: NOT_FOUND_HINT,
    },
  };
}

function buildRegisterValidationError(message: string): ProcedureFeedbackToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      success: false,
      error: "register_validation_failed",
      hint: NOT_FOUND_HINT,
    },
  };
}

function buildProcedureFeedbackSuccessResult(
  result: ProcedureEntry,
  success: boolean,
  context?: string,
  created?: boolean,
): ProcedureFeedbackToolResult {
  const lines: string[] = [];
  if (created) {
    lines.push(`📝 Procedure registered as draft: \`${result.id}\``);
  }
  if (success) {
    lines.push(
      `✅ Procedure validated (now ${result.successCount} successes, confidence: ${(result.confidence ?? 0).toFixed(2)})`,
    );
  } else {
    lines.push(
      `❌ Procedure failure recorded (now ${result.failureCount} failures, version ${result.version ?? 1}, confidence: ${(result.confidence ?? 0).toFixed(2)})`,
    );
    if (context) lines.push(`  Context: ${context}`);
    if (result.avoidanceNotes && result.avoidanceNotes.length > 0) {
      lines.push(`  Avoidance notes: ${result.avoidanceNotes.join("; ")}`);
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      success: true,
      procedureId: result.id,
      version: result.version,
      outcome: success ? "success" : "failure",
      successCount: result.successCount,
      failureCount: result.failureCount,
      successRate: result.successRate,
      ...(created ? { created: true } : {}),
    },
  };
}

function bootstrapProcedureIfMissing(
  factsDb: FactsDB,
  params: ProcedureFeedbackToolParams,
): { ok: true; created: boolean } | { ok: false; result: ProcedureFeedbackToolResult } {
  if (factsDb.getProcedureById(params.procedureId, params.scopeFilter)) {
    return { ok: true, created: false };
  }
  if (!params.registerIfMissing) {
    return { ok: false, result: buildProcedureNotFoundToolResult(params.procedureId) };
  }

  const taskPattern = params.taskPattern?.trim() ?? "";
  const steps = params.steps?.filter((s) => typeof s?.tool === "string" && s.tool.trim().length > 0) ?? [];
  if (!taskPattern || steps.length === 0) {
    return {
      ok: false,
      result: buildRegisterValidationError(
        "registerIfMissing requires `taskPattern` and at least one `steps[]` entry with a `tool` name when the procedure id does not exist.",
      ),
    };
  }

  const recipeJson = JSON.stringify(minimalRecipe(steps));
  const procedureType = params.procedureType ?? (params.success ? "positive" : "negative");
  factsDb.upsertProcedure({
    id: params.procedureId,
    taskPattern,
    recipeJson,
    procedureType,
    successCount: 0,
    failureCount: 0,
    lastValidated: null,
    lastFailed: null,
    confidence: 0.5,
  });
  return { ok: true, created: true };
}

/** Core handler for memory_procedure_feedback — testable without plugin API wiring. */
export function executeProcedureFeedbackTool(
  factsDb: FactsDB,
  params: ProcedureFeedbackToolParams,
): ProcedureFeedbackToolResult {
  const bootstrap = bootstrapProcedureIfMissing(factsDb, params);
  if (!bootstrap.ok) return bootstrap.result;

  const result = factsDb.procedureFeedback({
    procedureId: params.procedureId,
    success: params.success,
    context: params.context,
    failedAtStep: params.failedAtStep,
    duration: params.duration,
    tags: params.tags,
    userId: params.scopeFilter?.userId ?? undefined,
    agentId: params.scopeFilter?.agentId ?? undefined,
    sessionId: params.scopeFilter?.sessionId ?? undefined,
  });

  if (!result) {
    return buildProcedureNotFoundToolResult(params.procedureId);
  }

  return buildProcedureFeedbackSuccessResult(result, params.success, params.context, bootstrap.created);
}
