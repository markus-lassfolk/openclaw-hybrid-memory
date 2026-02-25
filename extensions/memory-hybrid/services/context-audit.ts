import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { HybridMemoryConfig } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import { estimateTokens } from "../utils/text.js";
import { parseDuration } from "../utils/duration.js";
import {
  readActiveTaskFile,
  buildActiveTaskInjection,
  buildStaleWarningInjection,
} from "./active-task.js";
import { capturePluginError } from "./error-reporter.js";

export type ContextAuditResult = {
  autoRecall: { enabled: boolean; budgetTokens: number; hotTokens: number; injectionFormat: string };
  procedures: { enabled: boolean; tokens: number; lines: number };
  activeTasks: { enabled: boolean; tokens: number; count: number; stale: number };
  workspaceFiles: { totalTokens: number; files: Array<{ file: string; tokens: number }> };
  totalTokens: number;
  recommendations: string[];
};

const DEFAULT_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
];

export async function runContextAudit(opts: {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  workspaceRoot?: string;
}): Promise<ContextAuditResult> {
  const { cfg, factsDb } = opts;
  const workspaceRoot = opts.workspaceRoot ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");

  const workspaceFiles: Array<{ file: string; tokens: number }> = [];
  for (const file of DEFAULT_BOOTSTRAP_FILES) {
    const fp = isAbsolute(file) ? file : join(workspaceRoot, file);
    if (!existsSync(fp)) continue;
    const content = readFileSync(fp, "utf-8");
    workspaceFiles.push({ file, tokens: estimateTokens(content) });
  }
  const workspaceTokens = workspaceFiles.reduce((sum, f) => sum + f.tokens, 0);

  let activeTasksTokens = 0;
  let activeTasksCount = 0;
  let activeTasksStale = 0;
  if (cfg.activeTask.enabled) {
    try {
      const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);
      const taskFile = await readActiveTaskFile(
        isAbsolute(cfg.activeTask.filePath) ? cfg.activeTask.filePath : join(workspaceRoot, cfg.activeTask.filePath),
        staleMinutes,
      );
      if (taskFile && taskFile.active.length > 0) {
        const injection = buildActiveTaskInjection(taskFile.active, cfg.activeTask.injectionBudget);
        let staleWarningBlock = "";
        if (cfg.activeTask.staleWarning.enabled) {
          const injectionChars = injection.length;
          const budgetChars = cfg.activeTask.injectionBudget * 4;
          const remainingChars = Math.max(0, budgetChars - injectionChars);
          staleWarningBlock = buildStaleWarningInjection(taskFile.active, staleMinutes, remainingChars);
        }
        const combined = [injection, staleWarningBlock].filter(Boolean).join("\n\n");
        activeTasksTokens = combined ? estimateTokens(combined) : 0;
        activeTasksCount = taskFile.active.length;
        activeTasksStale = taskFile.active.filter((t) => t.stale).length;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "active-task",
      });
    }
  }

  let proceduresTokens = 0;
  let proceduresLines = 0;
  if (cfg.procedures.enabled) {
    try {
      const procedures = factsDb.getProceduresForAudit(5);
      const positive = procedures.filter((p) => p.procedureType === "positive");
      const negative = procedures.filter((p) => p.procedureType === "negative");
      const lines: string[] = [];

      if (positive.length > 0) {
        lines.push("Last time this worked:");
        for (const p of positive.slice(0, 3)) {
          try {
            const steps = (JSON.parse(p.recipeJson) as Array<{ tool?: string }>).
              map((s) => s.tool).
              filter(Boolean).
              join(" → ");
            const emoji = p.confidence >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = p.confidence >= 0.7 ? "✅" : "⚠️";
            const confidence = Math.round(p.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${p.taskPattern.slice(0, 70)}…`);
          }
        }
      }

      if (negative.length > 0) {
        lines.push("⚠️ Known issue (avoid):");
        for (const n of negative.slice(0, 2)) {
          try {
            const steps = (JSON.parse(n.recipeJson) as Array<{ tool?: string }>).
              map((s) => s.tool).
              filter(Boolean).
              join(" → ");
            const emoji = n.confidence >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 50)}… (${steps})`);
          } catch {
            const emoji = n.confidence >= 0.7 ? "❌" : "⚠️";
            const confidence = Math.round(n.confidence * 100);
            lines.push(`- ${emoji} [${confidence}%] ${n.taskPattern.slice(0, 70)}…`);
          }
        }
      }

      if (lines.length > 0) {
        const block = `<relevant-procedures>\n${lines.join("\n")}\n</relevant-procedures>`;
        proceduresTokens = estimateTokens(block);
        proceduresLines = lines.length;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "procedures",
      });
    }
  }

  let hotTokens = 0;
  if (cfg.memoryTiering.enabled && cfg.memoryTiering.hotMaxTokens > 0) {
    try {
      const hotResults = factsDb.getHotFacts(cfg.memoryTiering.hotMaxTokens);
      if (hotResults.length > 0) {
        const hotLines = hotResults.map((r) => `- [hot/${r.entry.category}] ${(r.entry.summary || r.entry.text).slice(0, 200)}${(r.entry.summary || r.entry.text).length > 200 ? "…" : ""}`);
        const hotBlock = `<hot-memories>\n${hotLines.join("\n")}\n</hot-memories>`;
        hotTokens = estimateTokens(hotBlock);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "context-audit",
        operation: "hot-memories",
      });
    }
  }

  const autoRecallBudget = cfg.autoRecall.enabled
    ? (cfg.autoRecall.injectionFormat === "progressive" || cfg.autoRecall.injectionFormat === "progressive_hybrid")
      ? (cfg.autoRecall.progressiveIndexMaxTokens ?? cfg.autoRecall.maxTokens)
      : cfg.autoRecall.maxTokens
    : 0;

  const totalTokens = autoRecallBudget + hotTokens + proceduresTokens + activeTasksTokens + workspaceTokens;

  const recommendations: string[] = [];
  if (workspaceTokens > 3000) {
    recommendations.push("Trim bootstrap files (AGENTS.md / TOOLS.md / MEMORY.md) to keep total under ~3000 tokens.");
  }
  if (cfg.autoRecall.enabled && autoRecallBudget > 1200) {
    recommendations.push("Lower autoRecall.maxTokens or switch to progressive injection to save context.");
  }
  if (cfg.activeTask.enabled && activeTasksTokens > cfg.activeTask.injectionBudget) {
    recommendations.push("Active tasks exceed the injection budget; consider summarizing or lowering activeTask.injectionBudget.");
  }
  if (proceduresTokens > 600) {
    recommendations.push("Procedure injection is sizable; consider pruning procedures or raising the relevance threshold.");
  }
  if (totalTokens > 8000) {
    recommendations.push("Total injected context is high; reduce auto-recall, bootstrap files, or active tasks to avoid compaction.");
  }

  return {
    autoRecall: {
      enabled: cfg.autoRecall.enabled,
      budgetTokens: autoRecallBudget,
      hotTokens,
      injectionFormat: cfg.autoRecall.injectionFormat,
    },
    procedures: { enabled: cfg.procedures.enabled, tokens: proceduresTokens, lines: proceduresLines },
    activeTasks: { enabled: cfg.activeTask.enabled, tokens: activeTasksTokens, count: activeTasksCount, stale: activeTasksStale },
    workspaceFiles: { totalTokens: workspaceTokens, files: workspaceFiles },
    totalTokens,
    recommendations,
  };
}
