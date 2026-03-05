/**
 * Passive Observer Service — background fact extraction from session transcripts.
 *
 * Tails session JSONL logs, extracts facts via a cheap LLM, deduplicates against
 * recent stored facts (embedding similarity), and inserts to SQLite + LanceDB.
 *
 * Design differences from reflection:
 * - Trigger: automatic (interval) vs agent-initiated
 * - Input: raw transcripts vs already-stored facts
 * - Purpose: capture missed facts vs synthesize patterns
 * - Model: cheap nano tier vs session model
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "./embeddings.js";
import type OpenAI from "openai";
import type { MemoryCategory } from "../config.js";
import { chunkTextByChars } from "../utils/text.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { chatCompleteWithRetry, LLMRetryError } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import { normalizeVector, dotProductSimilarity } from "./reflection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PassiveObserverConfig {
  enabled: boolean;
  intervalMinutes: number;
  model?: string;
  maxCharsPerChunk: number;
  minImportance: number;
  deduplicationThreshold: number;
  sessionsDir?: string;
}

/** One extracted fact from the LLM response. */
export interface ExtractedFact {
  text: string;
  category: string;
  importance: number;
}

/** Per-session cursor: tracks how many characters have been processed. */
export type SessionCursors = Record<string, number>;

export interface ObserverRunResult {
  sessionsScanned: number;
  chunksProcessed: number;
  factsExtracted: number;
  factsStored: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// JSONL text extraction
// ---------------------------------------------------------------------------

/** Maximum length per message when building the transcript block. */
const MAX_MSG_LENGTH = 500;

/**
 * Extract readable text from a raw JSONL transcript chunk.
 * Pulls user messages and assistant text blocks — skips tool calls and results
 * to keep the prompt focused on natural language content.
 */
export function extractTextFromJsonlChunk(chunk: string): string {
  const lines = chunk.split("\n").filter((l) => l.trim());
  const parts: string[] = [];

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
    const rawContent = msg.content;

    // Plain string user message
    if (role === "user" && typeof rawContent === "string" && rawContent.trim()) {
      parts.push(`user: ${rawContent.trim().slice(0, MAX_MSG_LENGTH)}`);
      continue;
    }

    if (!Array.isArray(rawContent)) continue;

    const blocks = rawContent as Array<Record<string, unknown>>;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const type = block.type as string | undefined;

      // User text block
      if (role === "user" && type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push(`user: ${block.text.trim().slice(0, MAX_MSG_LENGTH)}`);
      }

      // Assistant text block (not tool calls)
      if (role === "assistant" && type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push(`assistant: ${block.text.trim().slice(0, MAX_MSG_LENGTH)}`);
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

export const DEFAULT_CURSORS_FILENAME = ".passive-observer-cursors.json";

export function getCursorsPath(dbDir: string): string {
  return join(dbDir, DEFAULT_CURSORS_FILENAME);
}

export async function loadCursors(cursorsPath: string): Promise<SessionCursors> {
  try {
    const raw = await readFile(cursorsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cursors: SessionCursors = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && v >= 0) {
          cursors[k] = v;
        }
      }
      return cursors;
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveCursors(cursorsPath: string, cursors: SessionCursors): Promise<void> {
  const dir = dirname(cursorsPath);
  await mkdir(dir, { recursive: true });
  await writeFile(cursorsPath, JSON.stringify(cursors, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const OBSERVER_TEMPERATURE = 0.15;
const OBSERVER_MAX_TOKENS = 1200;

/**
 * Parse the LLM JSON response into extracted facts.
 * Expects a JSON array of { text, category, importance } objects.
 */
export function parseObserverResponse(raw: string, categories: string[]): ExtractedFact[] {
  const validCategories = new Set<string>(categories);

  // Extract JSON from response (may be wrapped in markdown code fence)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

  let parsed: unknown;
  try {
    // Find the JSON array portion
    const start = jsonStr.indexOf("[");
    const end = jsonStr.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    parsed = JSON.parse(jsonStr.slice(start, end + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text || text.length < 10) continue;

    const importanceRaw = typeof obj.importance === "number" ? obj.importance : parseFloat(String(obj.importance));
    const importance = Number.isFinite(importanceRaw)
      ? Math.max(0, Math.min(1, importanceRaw))
      : 0;

    const categoryRaw = typeof obj.category === "string" ? obj.category.toLowerCase().trim() : "fact";
    const category = validCategories.has(categoryRaw) ? categoryRaw : "fact";

    facts.push({ text, category, importance });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

export async function runPassiveObserver(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  config: PassiveObserverConfig,
  allCategories: string[],
  opts: {
    model: string;
    fallbackModels?: string[];
    dbDir: string;
    dryRun?: boolean;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ObserverRunResult> {
  const result: ObserverRunResult = {
    sessionsScanned: 0,
    chunksProcessed: 0,
    factsExtracted: 0,
    factsStored: 0,
    errors: 0,
  };

  const sessionsDir = config.sessionsDir ?? join(homedir(), ".openclaw", "agents", "main", "sessions");
  if (!existsSync(sessionsDir)) {
    logger.info(`memory-hybrid: passive-observer — sessions dir not found: ${sessionsDir}`);
    return result;
  }

  let files: string[];
  try {
    files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionsDir, f));
  } catch (err) {
    logger.warn(`memory-hybrid: passive-observer — failed to read sessions dir: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "passive-observer-readdir",
      subsystem: "passive-observer",
    });
    result.errors++;
    return result;
  }

  if (files.length === 0) return result;

  const cursorsPath = getCursorsPath(opts.dbDir);
  const cursors = await loadCursors(cursorsPath);
  let cursorsChanged = false;

  // Check if any session has new content before computing embeddings
  let hasNewContent = false;
  for (const filePath of files) {
    try {
      const rawContent = await readFile(filePath, "utf-8");
      const sessionId = filePath.replace(/\\/g, "/").split("/").pop()!.replace(".jsonl", "");
      const cursor = cursors[sessionId] ?? 0;
      if (cursor < rawContent.length && rawContent.slice(cursor).trim()) {
        hasNewContent = true;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!hasNewContent) return result;

  // Collect recent fact vectors for dedup (only once per run, after confirming new content exists)
  const recentFacts = factsDb.getRecentFacts(7); // last 7 days
  const recentVectors: (number[] | null)[] = [];
  for (const f of recentFacts.slice(0, 200)) {
    try {
      recentVectors.push(normalizeVector(await embeddings.embed(f.text)));
    } catch {
      recentVectors.push(null);
    }
  }

  const prompt = loadPrompt("passive-observer");

  for (const filePath of files) {
    const sessionId = filePath.replace(/\\/g, "/").split("/").pop()!.replace(".jsonl", "");
    result.sessionsScanned++;

    let rawContent: string;
    try {
      rawContent = await readFile(filePath, "utf-8");
    } catch (err) {
      logger.warn(`memory-hybrid: passive-observer — failed to read session ${sessionId}: ${err}`);
      result.errors++;
      continue;
    }

    const cursor = cursors[sessionId] ?? 0;
    const contentLength = rawContent.length;
    if (cursor >= contentLength) continue; // Nothing new

    const newContent = rawContent.slice(cursor);
    if (!newContent.trim()) {
      cursors[sessionId] = contentLength;
      cursorsChanged = true;
      continue;
    }

    // Extract human-readable text from JSONL
    const textBlock = extractTextFromJsonlChunk(newContent);
    if (!textBlock.trim()) {
      cursors[sessionId] = contentLength;
      cursorsChanged = true;
      continue;
    }

    // Chunk the text block
    const chunks = chunkTextByChars(textBlock, config.maxCharsPerChunk, Math.floor(config.maxCharsPerChunk * 0.05));

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      result.chunksProcessed++;

      const filledPrompt = fillPrompt(prompt, {
        categories: allCategories.join(", "),
        transcript: chunk,
      });

      let rawResponse: string;
      try {
        rawResponse = await chatCompleteWithRetry({
          model: opts.model,
          content: filledPrompt,
          temperature: OBSERVER_TEMPERATURE,
          maxTokens: OBSERVER_MAX_TOKENS,
          openai,
          fallbackModels: opts.fallbackModels ?? [],
          label: "memory-hybrid: passive-observer",
        });
      } catch (err) {
        logger.warn(`memory-hybrid: passive-observer — LLM failed for session ${sessionId}: ${err}`);
        const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "passive-observer-llm",
          subsystem: "passive-observer",
          retryAttempt,
        });
        result.errors++;
        continue;
      }

      const facts = parseObserverResponse(rawResponse, allCategories);
      const filtered = facts.filter((f) => f.importance >= config.minImportance);
      result.factsExtracted += filtered.length;

      for (const fact of filtered) {
        // Embed new fact for dedup check
        let vec: number[];
        try {
          vec = await embeddings.embed(fact.text);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "passive-observer-embed",
            severity: "info",
            subsystem: "passive-observer",
          });
          continue;
        }

        const normVec = normalizeVector(vec);

        // Dedup check against recent facts
        let isDuplicate = false;
        for (const rv of recentVectors) {
          if (!rv || rv.length === 0) continue;
          if (dotProductSimilarity(normVec, rv) >= config.deduplicationThreshold) {
            isDuplicate = true;
            break;
          }
        }
        if (isDuplicate) continue;

        if (opts.dryRun) {
          logger.info(
            `memory-hybrid: passive-observer [dry-run] would store: ${fact.text.slice(0, 60)}... (importance=${fact.importance.toFixed(2)}, category=${fact.category})`,
          );
          result.factsStored++;
          recentVectors.push(normVec);
          continue;
        }

        // Store to SQLite
        const stored = factsDb.store({
          text: fact.text,
          category: fact.category as MemoryCategory,
          importance: fact.importance,
          entity: null,
          key: null,
          value: null,
          source: "passive-observer",
          decayClass: "session",
          tags: ["passive-observer"],
        });

        // Store to LanceDB
        try {
          await vectorDb.store({
            text: fact.text,
            vector: vec,
            importance: fact.importance,
            category: fact.category,
            id: stored.id,
          });
        } catch (err) {
          logger.warn(`memory-hybrid: passive-observer vector store failed: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "passive-observer-vector-store",
            subsystem: "vector",
            factId: stored.id,
          });
        }

        recentVectors.push(normVec);
        result.factsStored++;
      }
    }

    // Update cursor for this session
    cursors[sessionId] = contentLength;
    cursorsChanged = true;
  }

  if (cursorsChanged) {
    try {
      await saveCursors(cursorsPath, cursors);
    } catch (err) {
      logger.warn(`memory-hybrid: passive-observer — failed to save cursors: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "passive-observer-save-cursors",
        subsystem: "passive-observer",
      });
    }
  }

  return result;
}
