import { getEnv } from "../utils/env-manager.js";
/**
 * CLI Backfill, Ingest, and Analyze-Feedback-Phrases Handlers
 *
 * Contains the handler functions for the backfill, ingest-files, and
 * analyze-feedback-phrases CLI commands, along with their private helpers:
 *
 *   - gatherBackfillFiles        — locate MEMORY.md / memory/**\/*.md files
 *   - extractBackfillFact        — parse a single markdown line into a fact
 *   - runBackfillForCli          — backfill facts from workspace memory files
 *   - gatherSessionFiles         — locate session JSONL files under ~/.openclaw
 *   - extractTextFromSessionJsonl          — full text extraction from a session file
 *   - extractUserMessageTextsFromSessionJsonl — user-message-only extraction
 *   - runAnalyzeFeedbackPhrasesForCli      — discover praise/frustration phrases
 *   - runIngestFilesForCli       — ingest workspace markdown files via LLM
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel, getLLMModelPreference, isValidCategory } from "../config.js";
import { chatCompleteWithRetry, distillBatchTokenLimit, distillMaxOutputTokens } from "../services/chat.js";
import { capturePluginError } from "../services/error-reporter.js";
import { gatherIngestFiles } from "../services/ingest-utils.js";
import { BATCH_STORE_IMPORTANCE, DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import { tryExtractionFromTemplates } from "../utils/extraction-from-template.js";
import {
  getCorrectionSignalRegex,
  getExtractionTemplates,
  getReinforcementSignalRegex,
  loadUserFeedbackPhrases,
  saveUserFeedbackPhrases,
} from "../utils/language-keywords.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { chunkTextByChars, estimateTokens } from "../utils/text.js";

import { gatherSessionFiles } from "./cmd-distill.js";
import { createProgressReporter } from "./cmd-install.js";
import type { HandlerContext } from "./handlers.js";
import type { BackfillCliResult, BackfillCliSink, IngestFilesResult, IngestFilesSink } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const DEFAULT_INGEST_PATHS = ["skills/**/*.md", "TOOLS.md", "AGENTS.md"];

const SENTIMENT_BATCH_SIZE = 40;
const SENTIMENT_MSG_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function gatherBackfillFiles(workspaceRoot: string): Array<{ path: string; label: string }> {
  const memoryDir = join(workspaceRoot, "memory");
  const memoryMd = join(workspaceRoot, "MEMORY.md");
  const out: Array<{ path: string; label: string }> = [];
  if (existsSync(memoryMd)) out.push({ path: memoryMd, label: "MEMORY.md" });
  if (!existsSync(memoryDir)) return out;
  function walk(dir: string, rel = "memory"): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const relPath = join(rel, e.name);
      if (e.isDirectory()) {
        try {
          walk(full, relPath);
        } catch (err) {
          capturePluginError(err as Error, {
            operation: "walk-directory",
            severity: "info",
            subsystem: "cli",
          });
          /* ignore */
        }
      } else if (e.name.endsWith(".md")) out.push({ path: full, label: relPath });
    }
  }
  walk(memoryDir);
  return out;
}

/**
 * Extract fact from backfill line
 */
function extractBackfillFact(line: string): {
  text: string;
  category: string;
  entity: string | null;
  key: string | null;
  value: string;
  source_date: string | null;
} | null {
  let t = line.replace(/^[-*#>\s]+/, "").trim();
  const datePrefix = /^\[(\d{4}-\d{2}-\d{2})\]\s*/;
  let source_date: string | null = null;
  const match = t.match(datePrefix);
  if (match) {
    source_date = match[1];
    t = t.slice(match[0].length).trim();
  }
  if (t.length < 10 || t.length > 500) return null;
  const lower = t.toLowerCase();
  if (/\b(api[_-]?key|password|secret|token)\s*[:=]/i.test(t)) return null;
  if (/^(see\s|---|```|\s*$)/.test(t) || t.split(/\s+/).length < 2) return null;

  let entity: string | null = null;
  let key: string | null = null;
  let value: string;
  let category = "other";

  const decisionMatch = t.match(
    /(?:decided|chose|picked|went with)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for)\s+(.+?))?\.?$/i,
  );
  const decisionMatchSv = t.match(
    /(?:bestämde|valde)\s+(?:att\s+(?:använda\s+)?)?(.+?)(?:\s+(?:eftersom|för att)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    entity = "decision";
    key = decisionMatch[1].trim().slice(0, 100);
    value = (decisionMatch[2] || "no rationale").trim();
    category = "decision";
  } else if (decisionMatchSv) {
    entity = "decision";
    key = decisionMatchSv[1].trim().slice(0, 100);
    value = (decisionMatchSv[2] || "no rationale").trim();
    category = "decision";
  } else {
    const ruleMatch = t.match(/(?:always|never|alltid|aldrig)\s+(.+?)\.?$/i);
    if (ruleMatch) {
      entity = "convention";
      key = ruleMatch[1].trim().slice(0, 100);
      value = lower.includes("never") || lower.includes("aldrig") ? "never" : "always";
      category = "preference";
    } else {
      const possessiveMatch = t.match(/(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/);
      const possessiveMatchSv = t.match(/(?:mitt|min)\s+(\S+)\s+är\s+(.+?)\.?$/i);
      if (possessiveMatch) {
        entity = possessiveMatch[1] || "user";
        key = possessiveMatch[2].trim();
        value = possessiveMatch[3].trim();
        category = "fact";
      } else if (possessiveMatchSv) {
        entity = "user";
        key = possessiveMatchSv[1].trim();
        value = possessiveMatchSv[2].trim();
        category = "fact";
      } else {
        const preferMatch = t.match(/[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/);
        const preferMatchSv = t.match(/jag\s+(föredrar|gillar|ogillar|vill ha|behöver)\s+(.+?)\.?$/i);
        if (preferMatch) {
          entity = "user";
          key = preferMatch[1];
          value = preferMatch[2].trim();
          category = "preference";
        } else if (preferMatchSv) {
          entity = "user";
          key = preferMatchSv[1];
          value = preferMatchSv[2].trim();
          category = "preference";
        } else {
          const templateResult = tryExtractionFromTemplates(getExtractionTemplates(), t);
          if (templateResult?.entity && templateResult.value) {
            entity = templateResult.entity;
            key = templateResult.key;
            value = templateResult.value;
            if (entity === "decision") category = "decision";
            else if (entity === "convention") category = "preference";
            else if (entity === "user" && key) category = "preference";
            else category = "fact";
          } else {
            value = t.slice(0, 200);
          }
        }
      }
    }
  }
  return { text: t, category, entity, key, value, source_date };
}

/** Extract raw user message texts from a session file (for regex/sentiment). */
function extractUserMessageTextsFromSessionJsonl(filePath: string): string[] {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (!obj || typeof obj !== "object") continue;
      if (obj.type !== "message" || !obj.message || obj.message.role !== "user") continue;
      const content = obj.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          out.push(block.text.trim());
        }
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exported handler functions
// ---------------------------------------------------------------------------

/**
 * Backfill facts from workspace memory files
 */
export async function runBackfillForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; workspace?: string; limit?: number },
  sink: BackfillCliSink,
): Promise<BackfillCliResult> {
  const { factsDb, vectorDb, embeddings } = ctx;
  const workspaceRoot = opts.workspace ?? getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const files = gatherBackfillFiles(workspaceRoot);
  if (files.length === 0) {
    sink.log(`No MEMORY.md or memory/**/*.md under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, candidates: 0, files: 0, dryRun: opts.dryRun };
  }
  const allCandidates: Array<{
    text: string;
    category: string;
    entity: string | null;
    key: string | null;
    value: string;
    source_date: string | null;
    source: string;
  }> = [];
  for (const { path: filePath, label } of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const fact = extractBackfillFact(trimmed);
        if (fact) allCandidates.push({ ...fact, source: label });
      }
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:read-file", filePath });
    }
  }
  if (opts.dryRun) {
    sink.log(`Would process ${allCandidates.length} facts from ${files.length} files under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, candidates: allCandidates.length, files: files.length, dryRun: true };
  }
  const limit = opts.limit ?? 0;
  let stored = 0;
  let skipped = 0;
  const progress = createProgressReporter(sink, allCandidates.length, "Backfilling");
  const sourceDateSec = (s: string | null) => {
    if (!s || typeof s !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const sec = Math.floor(ms / 1000);
    return Number.isNaN(sec) ? null : sec;
  };
  let processed = 0;
  for (const fact of allCandidates) {
    if (limit > 0 && stored >= limit) break;
    progress.update(processed + 1);
    if (factsDb.hasDuplicate(fact.text)) {
      skipped++;
      processed++;
      continue;
    }
    try {
      const entry = factsDb.store({
        text: fact.text,
        category: fact.category as MemoryCategory,
        importance: 0.8,
        entity: fact.entity,
        key: fact.key,
        value: fact.value,
        source: `backfill:${fact.source}`,
        sourceDate: sourceDateSec(fact.source_date),
      });
      try {
        const vector = await embeddings.embed(fact.text);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: fact.text,
            vector,
            importance: 0.8,
            category: fact.category,
            id: entry.id,
          });
        }
      } catch (err) {
        sink.warn(`memory-hybrid: backfill vector store failed for "${fact.text.slice(0, 50)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:vector-store" });
      }
      stored++;
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runBackfillForCli:store-fact" });
    }
    processed++;
  }
  progress.done();
  return { stored, skipped, candidates: allCandidates.length, files: files.length, dryRun: opts.dryRun };
}

/**
 * Analyze session logs with an LLM to discover user-specific praise/frustration phrases.
 * Uses a cheap (nano-tier) model first to filter by sentiment; only pre-filtered messages go to the heavy-tier model.
 * Model-agnostic: nano and heavy models come from config (llm.nano / llm.default and llm.heavy).
 * When --days is omitted: first run uses 30 days, subsequent runs use 3 days (for weekly nightly).
 */
export async function runAnalyzeFeedbackPhrasesForCli(
  ctx: HandlerContext,
  opts: { days?: number; model?: string; outputPath?: string; learn?: boolean },
): Promise<{
  reinforcement: string[];
  correction: string[];
  sessionsScanned: number;
  learned?: boolean;
  error?: string;
}> {
  const { cfg, logger, openai } = ctx;
  const existing = loadUserFeedbackPhrases();
  const effectiveDays = opts.days ?? (existing.initialRunDone ? 3 : 30);
  const sessionFiles = gatherSessionFiles({ days: effectiveDays });
  if (sessionFiles.length === 0) {
    return {
      reinforcement: [],
      correction: [],
      sessionsScanned: 0,
      error: `No session files found under ~/.openclaw/agents/*/sessions/ in the last ${effectiveDays} days.`,
    };
  }

  const reinforcementRegex = getReinforcementSignalRegex();
  const correctionRegex = getCorrectionSignalRegex();
  const allTexts: string[] = [];
  for (const { path: fp } of sessionFiles) {
    try {
      allTexts.push(...extractUserMessageTextsFromSessionJsonl(fp));
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:read-session" });
    }
  }
  const unmatched = allTexts.filter((text) => {
    return !reinforcementRegex.test(text) && !correctionRegex.test(text);
  });

  let toAnalyze: string[] = [];
  if (unmatched.length > 0) {
    const nanoPref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
    const nanoModel = nanoPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
    const labels: string[] = [];
    for (let i = 0; i < unmatched.length; i += SENTIMENT_BATCH_SIZE) {
      const batch = unmatched.slice(i, i + SENTIMENT_BATCH_SIZE);
      const truncated = batch.map((t) => t.slice(0, SENTIMENT_MSG_MAX_CHARS).replace(/\n/g, " "));
      const prompt = `For each of the following user messages (one per line), output exactly one word per line in the same order: positive_feedback, negative_feedback, or neutral. Output ONLY one word per line, no preamble, no explanation.\n\n${truncated.join("\n")}`;
      try {
        const content = await chatCompleteWithRetry({
          model: nanoModel,
          content: prompt,
          temperature: 0,
          maxTokens: 500,
          openai,
          fallbackModels: nanoPref.length > 1 ? nanoPref.slice(1) : undefined,
          label: "memory-hybrid: feedback-phrases sentiment",
        });
        const lines = (content ?? "").split(/\r?\n/).map((l) => l.trim().toLowerCase());
        if (lines.length < batch.length) {
          logger.warn?.(
            `memory-hybrid: sentiment model returned ${lines.length} lines for batch of ${batch.length}; some messages may default to neutral`,
          );
        }
        for (let j = 0; j < batch.length; j++) {
          const word = lines[j] ?? "";
          if (word.includes("positive")) labels.push("positive_feedback");
          else if (word.includes("negative")) labels.push("negative_feedback");
          else labels.push("neutral");
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:sentiment" });
        labels.push(...batch.map(() => "neutral"));
      }
    }
    toAnalyze = unmatched.filter((_, idx) => labels[idx] !== "neutral");
  }

  if (toAnalyze.length === 0) {
    return { reinforcement: [], correction: [], sessionsScanned: sessionFiles.length };
  }

  const maxChars = 400_000;
  const userMessagesBlock = toAnalyze.map((t) => `User: ${t}`).join("\n");
  const truncatedBlock =
    userMessagesBlock.length > maxChars ? `${userMessagesBlock.slice(0, maxChars)}\n[truncated...]` : userMessagesBlock;
  const prompt = fillPrompt(loadPrompt("analyze-feedback-phrases"), { user_messages: truncatedBlock });
  const cronCfg = getCronModelConfig(cfg);
  const defaultPref = getLLMModelPreference(cronCfg, "default");
  const model = opts.model ?? defaultPref[0] ?? getDefaultCronModel(cronCfg, "default");
  const { spawn } = await import("node:child_process");
  const { tmpdir: osTmp } = await import("node:os");
  const promptPath = join(osTmp(), `analyze-feedback-phrases-${Date.now()}.txt`);
  writeFileSync(promptPath, prompt, "utf-8");
  try {
    // Build args conditionally: only add --model if model is truthy (avoids passing "undefined" string)
    const spawnArgs = ["sessions", "spawn"];
    if (model) spawnArgs.push("--model", model);
    spawnArgs.push(
      "--message",
      "Analyze the attached file and output ONLY a JSON object with keys reinforcement and correction (arrays of strings). No markdown, no code fences.",
      "--attach",
      promptPath,
    );
    // Use async spawn to avoid blocking the event loop during the LLM call (which may take 60–120+ seconds).
    // Stream accumulation removes the 2 MB maxBuffer ceiling of spawnSync.
    const r = await new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const child = spawn("openclaw", spawnArgs, { shell: process.platform === "win32" });
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (err: Error) => resolve({ stdout: "", stderr: "", status: null, error: err }));
      child.on("close", (code: number | null) =>
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          status: code,
        }),
      );
    });
    if (r.error) {
      return {
        reinforcement: [],
        correction: [],
        sessionsScanned: sessionFiles.length,
        error: `sessions spawn failed: ${r.error.message}`,
      };
    }
    const content = (r.stdout ?? "") + (r.stderr ?? "");
    if (r.status !== 0) {
      return {
        reinforcement: [],
        correction: [],
        sessionsScanned: sessionFiles.length,
        error: `sessions spawn exited ${r.status}: ${content.slice(0, 500)}`,
      };
    }
    // Robust JSON extraction: try full parse first, then locate first {...} block regardless of key order
    let reinforcement: string[] = [];
    let correction: string[] = [];
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return {
        reinforcement: [],
        correction: [],
        sessionsScanned: sessionFiles.length,
        error: "LLM returned empty output",
      };
    }
    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(trimmedContent);
    } catch {
      const braceStart = trimmedContent.indexOf("{");
      const braceEnd = trimmedContent.lastIndexOf("}");
      if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
        return {
          reinforcement: [],
          correction: [],
          sessionsScanned: sessionFiles.length,
          error: `Failed to locate JSON object in LLM output: ${trimmedContent.slice(0, 500)}`,
        };
      }
      try {
        parsedOutput = JSON.parse(trimmedContent.slice(braceStart, braceEnd + 1));
      } catch (e) {
        return {
          reinforcement: [],
          correction: [],
          sessionsScanned: sessionFiles.length,
          error: `Failed to parse LLM JSON: ${String(e)}`,
        };
      }
    }
    if (parsedOutput !== null && typeof parsedOutput === "object") {
      const obj = parsedOutput as { reinforcement?: unknown; correction?: unknown };
      if (Array.isArray(obj.reinforcement)) {
        reinforcement = obj.reinforcement.filter((s) => typeof s === "string" && s.trim()) as string[];
      }
      if (Array.isArray(obj.correction)) {
        correction = obj.correction.filter((s) => typeof s === "string" && s.trim()) as string[];
      }
    }
    if (opts.outputPath) {
      try {
        mkdirSync(dirname(opts.outputPath), { recursive: true });
        writeFileSync(
          opts.outputPath,
          JSON.stringify({ reinforcement, correction, sessionsScanned: sessionFiles.length }, null, 2),
          "utf-8",
        );
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runAnalyzeFeedbackPhrasesForCli:write-output" });
      }
    }
    let learned = false;
    if (opts.learn) {
      const merged = {
        reinforcement: [...new Set([...existing.reinforcement, ...reinforcement])],
        correction: [...new Set([...existing.correction, ...correction])],
        initialRunDone: true,
      };
      saveUserFeedbackPhrases(merged);
      learned = reinforcement.length > 0 || correction.length > 0;
      if (learned) {
        logger.info?.(
          `memory-hybrid: saved ${merged.reinforcement.length} reinforcement and ${merged.correction.length} correction phrases to .user-feedback-phrases.json`,
        );
      }
    } else if (!existing.initialRunDone) {
      // Persist initialRunDone even without --learn so the 30→3-day auto-window works on subsequent runs
      existing.initialRunDone = true;
      saveUserFeedbackPhrases(existing);
    }
    return { reinforcement, correction, sessionsScanned: sessionFiles.length, learned };
  } finally {
    try {
      if (existsSync(promptPath)) rmSync(promptPath, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Ingest files from workspace
 */
export async function runIngestFilesForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; workspace?: string; paths?: string[] },
  sink: IngestFilesSink,
): Promise<IngestFilesResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg } = ctx;
  const workspaceRoot = opts.workspace ?? getEnv("OPENCLAW_WORKSPACE") ?? process.cwd();
  const ingestCfg = cfg.ingest;
  const patterns = opts.paths?.length ? opts.paths : ingestCfg?.paths?.length ? ingestCfg.paths : DEFAULT_INGEST_PATHS;
  const chunkSize = ingestCfg?.chunkSize ?? 800;
  const overlap = ingestCfg?.overlap ?? 100;

  const files = gatherIngestFiles(workspaceRoot, patterns);
  if (files.length === 0) {
    sink.log(`No markdown files found for patterns: ${patterns.join(", ")} under ${workspaceRoot}`);
    return { stored: 0, skipped: 0, extracted: 0, files: 0, dryRun: opts.dryRun };
  }

  const cronCfgIngest = getCronModelConfig(cfg);
  const ingestPref = getLLMModelPreference(cronCfgIngest, "default");
  const model = ingestPref[0] ?? cfg.distill?.defaultModel ?? "gemini-3-pro-preview";
  const ingestFallbacks =
    ingestPref.length > 1 ? ingestPref.slice(1) : cfg.llm ? undefined : cfg.distill?.fallbackModels;
  const ingestPrompt = loadPrompt("ingest-files");
  const batches: string[] = [];
  let currentBatch = "";
  const batchTokenLimit = distillBatchTokenLimit(model);

  for (const fp of files) {
    try {
      const content = readFileSync(fp, "utf-8");
      if (!content.trim()) continue;
      const relPath = fp.startsWith(workspaceRoot) ? fp.slice(workspaceRoot.length).replace(/^\//, "") : basename(fp);
      const chunks = chunkTextByChars(content, chunkSize, overlap);
      for (let c = 0; c < chunks.length; c++) {
        const header =
          chunks.length === 1
            ? `\n--- FILE: ${relPath} ---\n\n`
            : `\n--- FILE: ${relPath} (chunk ${c + 1}/${chunks.length}) ---\n\n`;
        const block = header + chunks[c];
        const blockTokens = Math.ceil(block.length / 4);
        if (currentBatch.length > 0 && estimateTokens(currentBatch) + blockTokens > batchTokenLimit) {
          batches.push(currentBatch);
          currentBatch = block;
        } else {
          currentBatch += (currentBatch ? "\n" : "") + block;
        }
      }
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:read-file", filePath: fp });
    }
  }
  if (currentBatch.trim()) batches.push(currentBatch);

  const allFacts: Array<{
    category: string;
    text: string;
    entity?: string;
    key?: string;
    value?: string;
    tags?: string[];
  }> = [];
  for (let b = 0; b < batches.length; b++) {
    sink.log(`Processing batch ${b + 1}/${batches.length}...`);
    const userContent = `${ingestPrompt}\n\n${batches[b]}`;
    try {
      const content = await chatCompleteWithRetry({
        model: model,
        content: userContent,
        temperature: 0.2,
        maxTokens: distillMaxOutputTokens(model),
        openai,
        fallbackModels: ingestFallbacks,
        label: `memory-hybrid: ingest-files batch ${b + 1}/${batches.length}`,
      });
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const jsonMatch = line.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        try {
          const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          const category = String(obj.category || "technical").toLowerCase();
          const text = String(obj.text || "").trim();
          if (!text || text.length < 10) continue;
          const entity = typeof obj.entity === "string" ? obj.entity : null;
          const key = typeof obj.key === "string" ? obj.key : null;
          const value = typeof obj.value === "string" ? obj.value : entity && key ? text.slice(0, 200) : "";
          const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : [];
          allFacts.push({
            category: isValidCategory(category) ? category : "technical",
            text,
            entity: entity ?? undefined,
            key: key ?? undefined,
            value,
            tags: [...tags, "ingest"],
          });
        } catch (err) {
          capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:parse-json" });
        }
      }
    } catch (err) {
      sink.warn(`memory-hybrid: ingest-files LLM batch ${b + 1} failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:llm-batch" });
    }
  }

  if (opts.dryRun) {
    sink.log(`Would extract ${allFacts.length} facts from ${files.length} files`);
    return { stored: 0, skipped: 0, extracted: allFacts.length, files: files.length, dryRun: true };
  }

  let stored = 0;
  let skipped = 0;
  for (const fact of allFacts) {
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
        category: (isValidCategory(fact.category) ? fact.category : "technical") as MemoryCategory,
        importance: BATCH_STORE_IMPORTANCE,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? fact.text.slice(0, 200),
        source: "ingest",
        decayClass: "stable",
        tags: fact.tags,
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
        sink.warn(`memory-hybrid: ingest-files vector store failed for "${fact.text.slice(0, 40)}...": ${err}`);
        capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:vector-store" });
      }
      stored++;
    } catch (err) {
      sink.warn(`memory-hybrid: ingest-files store failed for "${fact.text.slice(0, 40)}...": ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runIngestFilesForCli:store-fact" });
    }
  }
  return { stored, skipped, extracted: allFacts.length, files: files.length, dryRun: false };
}
