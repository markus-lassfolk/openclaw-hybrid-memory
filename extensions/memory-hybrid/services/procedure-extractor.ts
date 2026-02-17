/**
 * Procedural memory (issue #23): extract tool-call sequences from session JSONL
 * and store as positive/negative procedures.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { ProcedureStep } from "../types/memory.js";

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
  const s = typeof content === "string" ? content : JSON.stringify(content);
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

/** Parse one session JSONL file content. Returns null if no tool calls or invalid. */
export function parseSessionJsonl(
  content: string,
  sessionId: string,
): ParsedSession | null {
  const lines = content.split("\n").filter((l) => l.trim());
  let taskIntent = "";
  const steps: ProcedureStep[] = [];
  let lastFailure: string | undefined;
  const toolUseMap = new Map<string, { name: string; args?: Record<string, unknown> }>();

  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    const msg = (obj as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;

    const role = msg.role as string | undefined;
    const content = msg.content as Array<{ type?: string; text?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string }> | undefined;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = block.type as string | undefined;

      if (type === "text" && role === "user" && !taskIntent && block.text) {
        taskIntent = normalizeTaskIntent(block.text);
      }

      if (role === "assistant" && type === "tool_use" && block.name) {
        const args = block.input != null && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : undefined;
        const id = block.id as string | undefined;
        if (id) toolUseMap.set(id, { name: block.name, args });
        steps.push({
          tool: block.name,
          args: args as Record<string, unknown> | undefined,
          summary: undefined,
        });
      }

      if (role === "tool" && (type === "tool_result" || type === "result")) {
        const toolContent = (block as Record<string, unknown>).content;
        if (looksLikeFailure(toolContent)) {
          lastFailure = typeof toolContent === "string" ? toolContent.slice(0, 200) : JSON.stringify(toolContent).slice(0, 200);
        }
      }
    }
  }

  if (!taskIntent || steps.length < 2) return null;

  return {
    sessionId,
    taskIntent,
    steps,
    success: !lastFailure,
    errorMessage: lastFailure,
  };
}

const SECRET_KEYS = new Set([
  "apikey", "api_key", "password", "token", "secret", "authorization",
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
};

export type ExtractProceduresResult = {
  sessionsScanned: number;
  proceduresStored: number;
  positiveCount: number;
  negativeCount: number;
  dryRun: boolean;
};

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
      logger.warn(`procedure-extractor: read failed ${filePath}: ${err}`);
      continue;
    }
    const sessionId = path.basename(filePath, ".jsonl");
    const parsed = parseSessionJsonl(content, sessionId);
    if (!parsed || parsed.steps.length < minSteps) continue;

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
    if (existing) {
      if (parsed.success) {
        factsDb.recordProcedureSuccess(existing.id);
      } else {
        factsDb.recordProcedureFailure(existing.id);
      }
      proceduresStored++;
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
