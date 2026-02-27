/**
 * Procedural memory: extract tool-call sequences from session JSONL
 * and store as positive/negative procedures.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { ProcedureStep } from "../types/memory.js";
import type { ExtractProceduresResult } from "../cli/register.js";
import { capturePluginError } from "./error-reporter.js";

export type ParsedSession = {
  sessionId: string;
  taskIntent: string;
  steps: ProcedureStep[];
  success: boolean;
  errorMessage?: string;
};

/** Normalize first user message as task intent (max 300 chars for storage). */
const TASK_INTENT_MAX = 300;

function normalizeTaskIntent(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TASK_INTENT_MAX);
}

/** Check if tool result content indicates failure (error, 404, exception, etc.). */
function looksLikeFailure(content: unknown): boolean {
  if (content == null) return false;
  
  // For objects, check for common error properties first before stringifying
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (obj.error || obj.statusCode === 404 || obj.failed || obj.exception) {
      return true;
    }
  }
  
  // For strings or small objects, check content
  let s: string;
  if (typeof content === "string") {
    s = content;
  } else {
    // Limit stringification to prevent performance issues with large objects
    try {
      const str = JSON.stringify(content);
      if (str.length > 10000) {
        // For very large responses, only check the first 10KB
        s = str.slice(0, 10000);
      } else {
        s = str;
      }
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'stringify-result',
        severity: 'info',
        subsystem: 'procedures'
      });
      // If stringification fails (circular refs, etc.), assume not a failure
      return false;
    }
  }
  
  const lower = s.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("404") ||
    lower.includes("failed") ||
    lower.includes("exception") ||
    lower.includes("econnrefused") ||
    lower.includes("html") && lower.includes("<!doctype")
  );
}

/** Reason a session was skipped (when includeSkipReason is true). */
export type ParseSkipReason = "no_task_intent" | "fewer_than_2_steps";

/** Parse one session JSONL file content. Returns null if no tool calls or invalid. */
export function parseSessionJsonl(
  content: string,
  sessionId: string,
  opts?: { includeSkipReason?: boolean },
): ParsedSession | { skipReason: ParseSkipReason } | null {
  const lines = content.split("\n").filter((l) => l.trim());
  let taskIntent = "";
  const steps: ProcedureStep[] = [];
  let lastFailure: string | undefined;

  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'parse-session-line',
        severity: 'info',
        subsystem: 'procedures'
      });
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    const msg = (obj as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;

    const role = msg.role as string | undefined;
    const rawContent = msg.content;

    // Accept content as array (OpenAI-style blocks) or as string (user message only)
    if (role === "user" && typeof rawContent === "string" && !taskIntent) {
      taskIntent = normalizeTaskIntent(rawContent);
    }

    if (!Array.isArray(rawContent)) continue;

    const content = rawContent as Array<{ type?: string; text?: string; name?: string; input?: unknown; arguments?: unknown; id?: string; tool_use_id?: string }>;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = block.type as string | undefined;

      if (type === "text" && role === "user" && !taskIntent && block.text) {
        taskIntent = normalizeTaskIntent(block.text);
      }

      // OpenAI: type "tool_use", args in block.input. OpenClaw: type "toolCall", args in block.arguments
      const isToolUse = type === "tool_use" || type === "toolCall";
      if (role === "assistant" && isToolUse && block.name) {
        const rawArgs = block.input ?? block.arguments;
        const args = rawArgs != null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : undefined;
        steps.push({
          tool: block.name,
          args: args as Record<string, unknown> | undefined,
          summary: undefined,
        });
      }

      // OpenAI: role "tool", type "tool_result", content in block.content. OpenClaw: role "toolResult", content may be in block.text
      const isToolResult = role === "tool" || role === "toolResult";
      if (isToolResult && (type === "tool_result" || type === "result" || type === "toolResult" || type === "text")) {
        const toolContent = (block as Record<string, unknown>).content ?? (block as Record<string, unknown>).text;
        if (looksLikeFailure(toolContent)) {
          lastFailure = typeof toolContent === "string" ? toolContent.slice(0, 200) : JSON.stringify(toolContent).slice(0, 200);
        } else {
          lastFailure = undefined;
        }
      }
    }
  }

  if (!taskIntent || steps.length < 2) {
    if (opts?.includeSkipReason) {
      return { skipReason: !taskIntent ? "no_task_intent" : "fewer_than_2_steps" };
    }
    return null;
  }

  return {
    sessionId,
    taskIntent,
    steps,
    success: !lastFailure,
    errorMessage: lastFailure,
  };
}

const SECRET_KEYS = new Set([
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
  "client_id",
  "private_key",
  "ssh_key",
  "credentials",
  "auth",
  "authentication",
]);

/** Build a minimal recipe for storage (strip noisy args, never store secrets). */
export function minimalRecipe(steps: ProcedureStep[]): ProcedureStep[] {
  return steps.map((s) => {
    const args = s.args;
    let safeArgs: Record<string, unknown> | undefined;
    if (args && typeof args === "object") {
      safeArgs = {};
      for (const [k, v] of Object.entries(args)) {
        if (SECRET_KEYS.has(k.toLowerCase())) continue;
        if (k === "query" || k === "url" || k === "path" || k === "command" || k === "name") {
          const str = typeof v === "string" ? v : JSON.stringify(v);
          safeArgs[k] = str.length > 200 ? str.slice(0, 200) + "…" : v;
        } else if (typeof v !== "object" || v === null) {
          safeArgs[k] = v;
        }
      }
    }
    return { tool: s.tool, args: safeArgs, summary: s.summary };
  });
}

export type ExtractProceduresOptions = {
  minSteps?: number;
  sessionDir?: string;
  filePaths?: string[];
  dryRun?: boolean;
  /** When true, log skip reason for each session that yields no procedure. */
  verbose?: boolean;
};

/** Calculate word overlap ratio between two task patterns (0.0 to 1.0). */
function taskSimilarity(pattern1: string, pattern2: string): number {
  const words1 = new Set(
    pattern1.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );
  const words2 = new Set(
    pattern2.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  return intersection.size / Math.min(words1.size, words2.size);
}

/**
 * Read session JSONL files (from directory or explicit paths), parse tool sequences,
 * and upsert into procedures table. Optionally store a procedure-tagged fact.
 */
export async function extractProceduresFromSessions(
  factsDb: FactsDB,
  options: ExtractProceduresOptions,
  logger: { info: (s: string) => void; warn: (s: string) => void },
): Promise<ExtractProceduresResult> {
  const minSteps = options.minSteps ?? 2;
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose === true;

  let filePaths: string[] = options.filePaths ?? [];
  if (filePaths.length === 0 && options.sessionDir) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = options.sessionDir;
    if (!fs.existsSync(dir)) {
      logger.warn(`procedure-extractor: session dir not found: ${dir}`);
      return { sessionsScanned: 0, proceduresStored: 0, positiveCount: 0, negativeCount: 0, dryRun };
    }
    const files = fs.readdirSync(dir);
    filePaths = files
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith(".deleted"))
      .map((f) => path.join(dir, f));
  }

  let proceduresStored = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const filePath of filePaths) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "procedure-extractor",
        operation: "read-session-file",
      });
      logger.warn(`procedure-extractor: read failed ${filePath}: ${err}`);
      continue;
    }
    const sessionId = path.basename(filePath, ".jsonl");
    const parsed = parseSessionJsonl(content, sessionId, verbose ? { includeSkipReason: true } : undefined);
    if (parsed && "skipReason" in parsed) {
      if (verbose) logger.info(`procedure-extractor: skip ${sessionId}.jsonl — ${parsed.skipReason}`);
      continue;
    }
    if (!parsed || parsed.steps.length < minSteps) {
      if (verbose && parsed) logger.info(`procedure-extractor: skip ${sessionId}.jsonl — fewer than minSteps (${parsed.steps.length} < ${minSteps})`);
      continue;
    }

    const recipe = minimalRecipe(parsed.steps);
    const recipeJson = JSON.stringify(recipe);
    const procedureType = parsed.success ? "positive" : "negative";
    if (procedureType === "positive") positiveCount++;
    else negativeCount++;

    if (dryRun) {
      logger.info(
        `[dry-run] ${procedureType}: ${parsed.taskIntent.slice(0, 60)}… (${recipe.length} steps) session=${sessionId}`,
      );
      proceduresStored++;
      continue;
    }

    const existing = factsDb.findProcedureByTaskPattern(parsed.taskIntent, 1)[0];
    if (existing && taskSimilarity(existing.taskPattern, parsed.taskIntent) >= 0.5) {
      let recorded = false;
      if (parsed.success) {
        recorded = factsDb.recordProcedureSuccess(existing.id, recipeJson, sessionId);
      } else {
        recorded = factsDb.recordProcedureFailure(existing.id, recipeJson, sessionId);
      }
      if (recorded) {
        proceduresStored++;
      }
    } else {
      factsDb.upsertProcedure({
        taskPattern: parsed.taskIntent,
        recipeJson,
        procedureType,
        successCount: parsed.success ? 1 : 0,
        failureCount: parsed.success ? 0 : 1,
        lastValidated: parsed.success ? Math.floor(Date.now() / 1000) : null,
        lastFailed: parsed.success ? null : Math.floor(Date.now() / 1000),
        confidence: parsed.success ? 0.6 : 0.5,
        ttlDays: 30,
        sourceSessionId: sessionId,
      });
      proceduresStored++;
    }
  }

  return {
    sessionsScanned: filePaths.length,
    proceduresStored,
    positiveCount,
    negativeCount,
    dryRun,
  };
}
