/**
 * Distill CLI Handler Functions
 *
 * Contains runDistillWindowForCli, runRecordDistillForCli, and runDistillForCli.
 * Extracted from handlers.ts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getLLMModelPreference, getDefaultCronModel } from "../config.js";
import { isValidCategory } from "../config.js";
import type { MemoryCategory } from "../config.js";
import { chatCompleteWithRetry, distillBatchTokenLimit, distillMaxOutputTokens } from "../services/chat.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import { estimateTokens, chunkSessionText } from "../utils/text.js";
import { extractTags } from "../utils/tags.js";
import { capturePluginError } from "../services/error-reporter.js";
import { isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { BATCH_STORE_IMPORTANCE, DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import type { DistillWindowResult, RecordDistillResult, DistillCliResult, DistillCliSink } from "./types.js";
import type { HandlerContext } from "./handlers.js";
import { buildPreFilterConfig, createProgressReporter } from "./cmd-install.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import { getMaxMtime } from "./cmd-extract.js";

// Constants used only by distill functions
const FULL_DISTILL_MAX_DAYS = 90;
const INCREMENTAL_MIN_DAYS = 3;

export function gatherSessionFiles(opts: {
  all?: boolean;
  days?: number;
  since?: string;
  sinceTimestampMs?: number;
}): Array<{ path: string; mtime: number }> {
  const openclawDir = join(homedir(), ".openclaw");
  const agentsDir = join(openclawDir, "agents");
  if (!existsSync(agentsDir)) return [];
  const cutoffMs =
    opts.sinceTimestampMs !== undefined
      ? opts.sinceTimestampMs
      : opts.since
        ? new Date(opts.since).getTime()
        : Date.now() - (opts.all ? 90 : (opts.days ?? 3)) * 24 * 60 * 60 * 1000;
  const out: Array<{ path: string; mtime: number }> = [];
  try {
    for (const agentName of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentName.isDirectory()) continue;
      const sessionsDir = join(agentsDir, agentName.name, "sessions");
      if (!existsSync(sessionsDir)) continue;
      for (const f of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith(".deleted")) continue;
        const fp = join(sessionsDir, f.name);
        try {
          const stat = statSync(fp);
          if (stat.mtimeMs > cutoffMs) out.push({ path: fp, mtime: stat.mtimeMs });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles:stat", filePath: fp });
        }
      }
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "gatherSessionFiles" });
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/**
 * Extract text content from session JSONL file
 */
export function extractTextFromSessionJsonl(filePath: string): string {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (obj.type !== "message" || !obj.message) continue;
      const msg = obj.message;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          parts.push(block.text.trim());
        }
      }
    } catch {
      // NOTE: Intentionally NOT using capturePluginError here to avoid flooding
      // error logs with JSON parse errors from malformed session lines.
      // This is a best-effort parser; we skip bad lines silently.
    }
  }
  return parts.join("\n\n");
}

export function runDistillWindowForCli(ctx: HandlerContext, _opts: { json: boolean }): DistillWindowResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  const distillLastRunPath = join(memoryDir, ".distill_last_run");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let mode: "full" | "incremental";
  let startDate: string;
  const endDate = today;
  let mtimeDays: number;

  if (!existsSync(distillLastRunPath)) {
    mode = "full";
    const start = new Date(now);
    start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
    startDate = start.toISOString().slice(0, 10);
    mtimeDays = FULL_DISTILL_MAX_DAYS;
  } else {
    try {
      const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
      if (!line) {
        mode = "full";
        const start = new Date(now);
        start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
        startDate = start.toISOString().slice(0, 10);
        mtimeDays = FULL_DISTILL_MAX_DAYS;
      } else {
        const lastRun = new Date(line);
        if (Number.isNaN(lastRun.getTime())) {
          mode = "full";
          const start = new Date(now);
          start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
          startDate = start.toISOString().slice(0, 10);
          mtimeDays = FULL_DISTILL_MAX_DAYS;
        } else {
          mode = "incremental";
          const lastRunDate = lastRun.toISOString().slice(0, 10);
          const threeDaysAgo = new Date(now);
          threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
          const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
          startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
          const start = new Date(startDate);
          mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
          if (mtimeDays < 1) mtimeDays = 1;
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runDistillWindowForCli" });
      mode = "full";
      const start = new Date(now);
      start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
      startDate = start.toISOString().slice(0, 10);
      mtimeDays = FULL_DISTILL_MAX_DAYS;
    }
  }
  return { mode, startDate, endDate, mtimeDays };
}

/**
 * Record distillation run timestamp
 */
export function runRecordDistillForCli(ctx: HandlerContext): RecordDistillResult {
  const { resolvedSqlitePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, ".distill_last_run");
  const ts = new Date().toISOString();
  try {
    writeFileSync(path, ts + "\n", "utf-8");
    return { path, timestamp: ts };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runRecordDistillForCli" });
    throw err;
  }
}

export async function runDistillForCli(
  ctx: HandlerContext,
  opts: {
    dryRun: boolean;
    all?: boolean;
    days?: number;
    since?: string;
    model?: string;
    verbose?: boolean;
    maxSessions?: number;
    maxSessionTokens?: number;
    full?: boolean;
  },
  sink: DistillCliSink,
): Promise<DistillCliResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, logger } = ctx;
  const SCAN_TYPE = "distill";
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when --all/--full/--since overrides watermark)
  const useWatermark = !opts.full && !opts.all && !opts.since;
  if (useWatermark && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return { sessionsScanned: 0, factsExtracted: 0, stored: 0, dedupSkipped: 0, dryRun: false, skipped: true };
  }

  try {
    const gatherOpts =
      useWatermark && cursor && cursor.lastSessionTs > 0
        ? { sinceTimestampMs: cursor.lastSessionTs }
        : { all: opts.all, days: opts.days ?? (opts.all ? 90 : 3), since: opts.since };

    if (useWatermark && cursor && cursor.lastSessionTs > 0) {
      logger.info?.(
        `memory-hybrid: distill incremental — sessions since last run (${new Date(cursor.lastSessionTs).toISOString()})`,
      );
    }

    const sessionFiles = gatherSessionFiles(gatherOpts);
    const maxSessions = opts.maxSessions ?? 0;
    let filesToProcess = maxSessions > 0 ? sessionFiles.slice(0, maxSessions) : sessionFiles;
    if (filesToProcess.length === 0) {
      sink.log("No session files found under ~/.openclaw/agents/*/sessions/");
      if (useWatermark && !opts.dryRun) {
        factsDb.updateScanCursor(SCAN_TYPE, 0, 0);
        clearScanLock(SCAN_TYPE);
      }
      return { sessionsScanned: 0, factsExtracted: 0, stored: 0, dedupSkipped: 0, dryRun: opts.dryRun };
    }

    // Two-tier pre-filter: use local Ollama to triage sessions before cloud LLM (Issue #290).
    // allCandidatePaths captures the full candidate set BEFORE pre-filtering so the cursor
    // watermark always advances past skipped sessions, preventing infinite re-processing loops.
    const allCandidatePaths = filesToProcess.map((f) => f.path);
    const pfCfg = buildPreFilterConfig(cfg);
    if (pfCfg.enabled && filesToProcess.length > 0) {
      const pfResult = await preFilterSessions(allCandidatePaths, pfCfg);
      if (!pfResult.ollamaUnavailable) {
        const keptSet = new Set(pfResult.kept);
        const originalCount = filesToProcess.length;
        filesToProcess = filesToProcess.filter((f) => keptSet.has(f.path));
        sink.log(
          `memory-hybrid: distill pre-filter: ${filesToProcess.length}/${originalCount} sessions flagged as interesting (${pfResult.skipped.length} skipped by local model)`,
        );
      } else {
        sink.log("memory-hybrid: distill pre-filter: Ollama unavailable — processing all sessions");
      }
    }

    const cronCfgDistill = getCronModelConfig(cfg);
    const heavyPref = getLLMModelPreference(cronCfgDistill, "heavy");
    const model =
      opts.model ?? heavyPref[0] ?? cfg.distill?.defaultModel ?? getDefaultCronModel(cronCfgDistill, "heavy");
    const distillFallbacks =
      heavyPref.length > 1 ? heavyPref.slice(1) : cfg.llm ? undefined : cfg.distill?.fallbackModels;
    const batches: string[] = [];
    let currentBatch = "";
    const batchTokenLimit = distillBatchTokenLimit(model);
    const maxSessionTokens = opts.maxSessionTokens ?? batchTokenLimit;
    for (let i = 0; i < filesToProcess.length; i++) {
      const { path: fp } = filesToProcess[i];
      try {
        const text = extractTextFromSessionJsonl(fp);
        if (!text.trim()) continue;
        const textTokens = Math.ceil(text.length / 4);
        const chunks = chunkSessionText(text, maxSessionTokens);
        if (chunks.length > 1) {
          sink.log(
            `memory-hybrid: distill: session too large (${textTokens} tokens), splitting into ${chunks.length} chunks`,
          );
        }

        // Safety check: ensure chunks don't exceed model-specific batch limits
        const safeLimit = batchTokenLimit; // Use model-specific limit instead of hardcoded 350k
        const validChunks = chunks.filter((chunk, idx) => {
          const chunkTokens = Math.ceil(chunk.length / 4);
          if (chunkTokens > safeLimit) {
            sink.warn(`memory-hybrid: distill: chunk ${idx + 1} too large (${chunkTokens} tokens), skipping`);
            return false;
          }
          return true;
        });

        for (let c = 0; c < validChunks.length; c++) {
          const header =
            validChunks.length === 1
              ? `\n--- SESSION: ${basename(fp)} ---\n\n`
              : `\n--- SESSION: ${basename(fp)} (chunk ${c + 1}/${validChunks.length}) ---\n\n`;
          const block = header + validChunks[c];
          const blockTokens = Math.ceil(block.length / 4);
          if (currentBatch.length > 0 && estimateTokens(currentBatch) + blockTokens > batchTokenLimit) {
            batches.push(currentBatch);
            currentBatch = block;
          } else {
            currentBatch += (currentBatch ? "\n" : "") + block;
          }
        }
      } catch (err) {
        capturePluginError(err as Error, {
          subsystem: "cli",
          operation: "runDistillForCli:extract-text",
          filePath: fp,
        });
      }
    }
    if (currentBatch.trim()) batches.push(currentBatch);
    const distillPrompt = loadPrompt("distill-sessions");
    const allFacts: Array<{
      category: string;
      text: string;
      entity?: string;
      key?: string;
      value?: string;
      source_date?: string;
      tags?: string[];
    }> = [];
    const progress = createProgressReporter(sink, batches.length, "Distilling sessions");
    for (let b = 0; b < batches.length; b++) {
      progress.update(b + 1);
      const userContent = distillPrompt + "\n\n" + batches[b];
      try {
        const content = await chatCompleteWithRetry({
          model,
          content: userContent,
          temperature: 0.2,
          maxTokens: distillMaxOutputTokens(model),
          openai,
          fallbackModels: distillFallbacks,
          label: `memory-hybrid: distill batch ${b + 1}/${batches.length}`,
        });
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const jsonMatch = line.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;
          try {
            const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            const category = String(obj.category || "other").toLowerCase();
            const text = String(obj.text || "").trim();
            if (!text || text.length < 10) continue;
            const entity = typeof obj.entity === "string" ? obj.entity : null;
            const key = typeof obj.key === "string" ? obj.key : null;
            const value = typeof obj.value === "string" ? obj.value : entity && key ? text.slice(0, 200) : "";
            const source_date = typeof obj.source_date === "string" ? obj.source_date : null;
            const tags = Array.isArray(obj.tags)
              ? (obj.tags as string[]).filter((t) => typeof t === "string")
              : undefined;
            allFacts.push({
              category,
              text,
              entity: entity ?? undefined,
              key: key ?? undefined,
              value,
              source_date: source_date ?? undefined,
              tags,
            });
          } catch (err) {
            capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:parse-json" });
          }
        }
      } catch (err) {
        sink.warn(`memory-hybrid: distill LLM batch ${b + 1} failed: ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:llm-batch" });
      }
    }
    progress.done();
    if (opts.dryRun) {
      sink.log(`Would extract ${allFacts.length} facts from ${filesToProcess.length} sessions`);
      return {
        sessionsScanned: filesToProcess.length,
        factsExtracted: allFacts.length,
        stored: 0,
        dedupSkipped: 0,
        dryRun: true,
      };
    }
    const sourceDateSec = (s: string | null | undefined) => {
      if (!s || typeof s !== "string") return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
      if (!m) return null;
      return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
    };
    let stored = 0;
    let skipped = 0;
    for (const fact of allFacts) {
      const isCred = isCredentialLike(fact.text, fact.entity ?? null, fact.key ?? null, fact.value);
      if (isCred && cfg.credentials.enabled && credentialsDb) {
        const parsed = tryParseCredentialForVault(fact.text, fact.entity ?? null, fact.key ?? null, fact.value, {
          requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
        });
        if (parsed) {
          if (!opts.dryRun) {
            let storedInVault = false;
            try {
              const storeResult = credentialsDb.storeIfNew({
                service: parsed.service,
                type: parsed.type as any,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              if (!storeResult) {
                continue;
              }
              storedInVault = true;
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in vault.`;
              const entry = factsDb.store({
                text: pointerText,
                category: "technical",
                importance: BATCH_STORE_IMPORTANCE,
                entity: "Credentials",
                key: parsed.service,
                value: `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`,
                source: "distillation",
                sourceDate: sourceDateSec(fact.source_date),
              });
              try {
                const vector = await embeddings.embed(pointerText);
                factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
                if (!(await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD))) {
                  await vectorDb.store({
                    text: pointerText,
                    vector,
                    importance: BATCH_STORE_IMPORTANCE,
                    category: "technical",
                    id: entry.id,
                  });
                }
              } catch (err) {
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: "runDistillForCli:credential-vector-store",
                });
              }
              stored++;
              if (opts.verbose) sink.log(`  stored credential: ${parsed.service}`);
            } catch (err) {
              if (storedInVault) {
                try {
                  credentialsDb.delete(parsed.service, parsed.type as any);
                } catch (cleanupErr) {
                  if (opts.verbose)
                    sink.log(`  failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`);
                  capturePluginError(cleanupErr as Error, {
                    subsystem: "cli",
                    operation: "runDistillForCli:credential-compensating-delete",
                  });
                }
              }
              capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:credential-store" });
            }
          }
          continue;
        }
        continue;
      }
      if (factsDb.hasDuplicate(fact.text)) {
        skipped++;
        continue;
      }
      try {
        const vector = await embeddings.embed(fact.text);
        if (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD)) {
          skipped++;
          continue;
        }
        const entry = factsDb.store({
          text: fact.text,
          category: (isValidCategory(fact.category) ? fact.category : "other") as MemoryCategory,
          importance: BATCH_STORE_IMPORTANCE,
          entity: fact.entity ?? null,
          key: fact.key ?? null,
          value: fact.value ?? fact.text.slice(0, 200),
          source: "distillation",
          sourceDate: sourceDateSec(fact.source_date),
          tags: fact.tags?.length ? fact.tags : extractTags(fact.text, fact.entity ?? undefined),
        });
        try {
          await vectorDb.store({
            text: fact.text,
            vector,
            importance: BATCH_STORE_IMPORTANCE,
            category: fact.category,
            id: entry.id,
          });
          factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        } catch (err) {
          sink.warn(`memory-hybrid: distill vector store failed for "${fact.text.slice(0, 40)}...": ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:vector-store" });
        }
        stored++;
        if (opts.verbose) sink.log(`  stored: [${fact.category}] ${fact.text.slice(0, 60)}...`);
      } catch (err) {
        sink.warn(`memory-hybrid: distill store failed for "${fact.text.slice(0, 40)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:store-fact" });
      }
    }
    try {
      runRecordDistillForCli(ctx);
    } catch (err) {
      sink.warn(`memory-hybrid: failed to record distill timestamp: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runDistillForCli:record-timestamp" });
    }
    if (!opts.dryRun) {
      // Use allCandidatePaths (pre-filter input) so skipped sessions advance the watermark.
      const lastSessionTs = getMaxMtime(allCandidatePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, allCandidatePaths.length);
    }
    return {
      sessionsScanned: filesToProcess.length,
      factsExtracted: allFacts.length,
      stored,
      dedupSkipped: skipped,
      dryRun: false,
    };
  } finally {
    if (useWatermark && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
