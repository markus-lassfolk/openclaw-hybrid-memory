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

import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import type { EventLog } from "../backends/event-log.js";
import { categoryToEventType } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryCategory, ReinforcementConfig } from "../config.js";
import { nowIso } from "../utils/dates.js";
import {
  capTimeoutByMaintenanceRunDeadline,
  getMaintenanceRunAbortSignal,
  maintenanceRunDeadlineReached,
} from "../utils/maintenance-run-deadline.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { chunkTextByChars } from "../utils/text.js";
import { runCaptureStoreWithDedupWindow } from "./capture-dedup.js";
import { chatCompleteWithRetry, LLMRetryError, resolveMaintenanceChatTimeoutMs } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import type { ProvenanceService } from "./provenance.js";
import {
  isSubstantiveMemoryText,
  prepareMemoryMetadataForStorage,
  prepareMemoryTextForStorage,
} from "./recalled-context-assembler.js";
import { dotProductSimilarity, normalizeVector } from "./reflection.js";
import { cleanupEvictedVector } from "./vector-maintenance.js";

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

/** Per-session cursor: tracks byte offset into the session file. */
type SessionCursors = Record<string, number>;

interface ObserverRunResult {
  sessionsScanned: number;
  chunksProcessed: number;
  factsExtracted: number;
  factsStored: number;
  factsReinforced: number;
  errors: number;
}

// Track consecutive failures across runs to prevent infinite retries on bad session files.
const consecutiveFailures = new Map<string, number>();

/** Returns true when the error is an ENOENT (file not found) OS error. */
const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Whether a basename under the OpenClaw sessions dir should be scanned for passive extraction.
 * Excludes `.checkpoint.` sidecars (often a single multi‑MB JSON line — not chat transcripts)
 * and `.deleted*` tombstones (same convention as procedure-extractor).
 */
export function isPassiveObserverTranscriptCandidate(basename: string): boolean {
  return (
    basename.endsWith(".jsonl") &&
    !basename.startsWith(".deleted") &&
    !basename.includes(".checkpoint.") &&
    !basename.includes(".trajectory.")
  );
}

// ---------------------------------------------------------------------------
// JSONL text extraction
// ---------------------------------------------------------------------------

/** Maximum length per message when building the transcript block. */
const MAX_MSG_LENGTH = 500;
/** Hard cap on bytes read per session per run to avoid unbounded JSONL reads. */
const MAX_JSONL_BYTES_PER_RUN = 2_000_000;
/** Per-session progress log throttle, matching the orchestrator's per-step heartbeat cadence (#2032). */
const PASSIVE_OBSERVER_PROGRESS_LOG_INTERVAL_MS = 60_000;

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

    // Plain string assistant message
    if (role === "assistant" && typeof rawContent === "string" && rawContent.trim()) {
      parts.push(`assistant: ${rawContent.trim().slice(0, MAX_MSG_LENGTH)}`);
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

const DEFAULT_CURSORS_FILENAME = ".passive-observer-cursors.json";

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
  const validCategories = new Set<string>(categories.map((c) => c.toLowerCase()));

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

    const importanceRaw =
      typeof obj.importance === "number" ? obj.importance : Number.parseFloat(String(obj.importance));
    // Default to 0.0 when importance is missing/invalid — forces the LLM to explicitly assign
    // importance rather than having invalid/missing values silently pass the minImportance filter.
    const importance = Number.isFinite(importanceRaw) ? Math.max(0, Math.min(1, importanceRaw)) : 0.0;

    const categoryRaw = typeof obj.category === "string" ? obj.category.toLowerCase().trim() : "fact";
    const category = validCategories.has(categoryRaw) ? categoryRaw : "fact";

    facts.push({ text, category, importance });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Identity fact detection (Issue #306)
// ---------------------------------------------------------------------------

/**
 * Returns true when a fact describes the agent's own identity (email, name, role, etc.).
 * These facts should be stored as global/permanent instead of session-scoped.
 *
 * @param text - The fact text to classify.
 * @param agentName - Optional known agent name. When provided, adds a
 *   name-specific pattern so "[AgentName]'s email is …" is also detected.
 */
export function isIdentityFact(text: string, agentName?: string): boolean {
  const patterns: RegExp[] = [
    /(?:my|your|the (?:agent|assistant|bot)(?:'s)?)\s+(?:email|name|role|account|address|phone|number)/i,
    /(?<!(?:user|customer|their|his|her|[a-z]+)'s\s)(?<!(?:their|his|her)\s)(?:email|account|address|role)\s+(?:is|was|:)\s/i,
  ];
  if (agentName) {
    const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push(new RegExp(`${escaped}(?:'s)?\\s+(?:email|name|role|account)`, "i"));
  }
  return patterns.some((p) => p.test(text));
}

const OPENCLAW_AGENTS_MARKER = "/.openclaw/agents/";

/** List session JSONL paths for passive observer (single configured dir or all agents). */
export function listPassiveObserverSessionFilePaths(
  sessionsDir: string | undefined,
  proceduresSessionsDir: string | undefined,
): { filePaths: string[]; multiAgentScan: boolean } {
  const explicitDir = sessionsDir ?? proceduresSessionsDir;
  if (explicitDir) {
    if (!existsSync(explicitDir)) return { filePaths: [], multiAgentScan: false };
    try {
      const filePaths = readdirSync(explicitDir)
        .filter(isPassiveObserverTranscriptCandidate)
        .sort()
        .map((f) => join(explicitDir, f));
      return { filePaths, multiAgentScan: false };
    } catch {
      return { filePaths: [], multiAgentScan: false };
    }
  }

  const agentsDir = join(homedir(), ".openclaw", "agents");
  if (!existsSync(agentsDir)) return { filePaths: [], multiAgentScan: true };
  const filePaths: string[] = [];
  try {
    for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const dir = join(agentsDir, agentEntry.name, "sessions");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (isPassiveObserverTranscriptCandidate(f)) {
          filePaths.push(join(dir, f));
        }
      }
    }
  } catch {
    return { filePaths: [], multiAgentScan: true };
  }
  filePaths.sort();
  return { filePaths, multiAgentScan: true };
}

/** Stable cursor / scope key for a session file (agent-relative when scanning all agents). */
export function deriveObserverSessionKey(filePath: string, multiAgentScan: boolean): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (multiAgentScan) {
    const markerIdx = normalized.indexOf(OPENCLAW_AGENTS_MARKER);
    if (markerIdx >= 0) {
      const rel = normalized.slice(markerIdx + OPENCLAW_AGENTS_MARKER.length);
      return rel.replace(/\.jsonl$/, "");
    }
  }
  const base = normalized.split("/").pop()?.replace(".jsonl", "");
  return base ?? null;
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

export async function runPassiveObserver(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  config: PassiveObserverConfig,
  allCategories: string[],
  opts: {
    model: string;
    fallbackModels?: string[];
    dbDir: string;
    dryRun?: boolean;
    /** Fallback sessions dir from procedures config (used when config.sessionsDir is not set). */
    proceduresSessionsDir?: string;
    /** Confidence reinforcement config (Issue #147). When set and enabled, similar facts get confidence boost instead of silent skip. */
    reinforcement?: ReinforcementConfig;
    /** Provenance tracking (Issue #163). */
    provenanceService?: ProvenanceService | null;
    /** Episodic event log (Issue #150). When set, each stored fact is also appended to Layer 1. */
    eventLog?: EventLog | null;
    /** Agent's own name. Used by isIdentityFact() for name-specific detection. */
    agentName?: string;
    /** Observation dedup window in minutes (#1913). */
    dedupWindowMinutes?: number;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ObserverRunResult> {
  const result: ObserverRunResult = {
    sessionsScanned: 0,
    chunksProcessed: 0,
    factsExtracted: 0,
    factsStored: 0,
    factsReinforced: 0,
    errors: 0,
  };

  const explicitSessionsDir = config.sessionsDir ?? opts.proceduresSessionsDir;
  const { filePaths, multiAgentScan } = listPassiveObserverSessionFilePaths(
    config.sessionsDir,
    opts.proceduresSessionsDir,
  );

  if (filePaths.length === 0 && explicitSessionsDir && !existsSync(explicitSessionsDir)) {
    logger.info(`memory-hybrid: passive-observer — sessions dir not found: ${explicitSessionsDir}`);
    return result;
  }

  if (filePaths.length === 0 && !multiAgentScan) {
    return result;
  }

  if (filePaths.length === 0 && multiAgentScan) {
    logger.info("memory-hybrid: passive-observer — no session files found under ~/.openclaw/agents/*/sessions");
    return result;
  }

  // Prune stale consecutiveFailures entries before any early returns, so sessions that
  // disappear from disk (or when there are no session files at all) get cleaned up every tick.
  {
    const activeIds = new Set(
      filePaths.map((fp) => deriveObserverSessionKey(fp, multiAgentScan)).filter((id): id is string => id != null),
    );
    for (const id of consecutiveFailures.keys()) {
      if (!activeIds.has(id)) consecutiveFailures.delete(id);
    }
  }

  if (filePaths.length === 0) return result;

  const cursorsPath = getCursorsPath(opts.dbDir);
  const cursors = await loadCursors(cursorsPath);
  let cursorsChanged = false;
  // Separate in-memory map for consecutive failure counts — not persisted to the cursors file
  // to avoid mixing byte-offset semantics with failure-count semantics in the same structure.

  // ---------------------------------------------------------------------------
  // Phase 1: scan all session files, count sessions, detect whether any have
  // new content.  We use stat() to get file sizes without loading entire files
  // into memory (files are read lazily in Phase 3 only when needed).
  // ---------------------------------------------------------------------------
  interface SessionInfo {
    filePath: string;
    sessionId: string;
    fileBytelen: number;
    cursor: number;
  }

  const sessions: SessionInfo[] = [];
  const activeSessionIds = new Set<string>();
  let hasNewContent = false;

  for (const filePath of filePaths) {
    const sessionId = deriveObserverSessionKey(filePath, multiAgentScan);
    if (!sessionId) continue;
    activeSessionIds.add(sessionId);
    let fileBytelen: number;
    try {
      const stats = await stat(filePath);
      fileBytelen = stats.size;
    } catch (err) {
      if (isEnoent(err)) {
        // File was pruned by session.maintenance between readdirSync and stat — skip silently.
        logger.info(`memory-hybrid: passive-observer — session ${sessionId} was pruned, skipping`);
        continue;
      }
      logger.warn(`memory-hybrid: passive-observer — failed to stat session ${sessionId}: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "passive-observer-stat",
        subsystem: "passive-observer",
      });
      result.errors++;
      continue;
    }

    // sessionsScanned counts sessions whose stat succeeded. A later open ENOENT (Phase 3)
    // will still leave this counter incremented, so operators may observe
    // sessionsScanned > factsStored with no errors — this is intentional and expected.
    result.sessionsScanned++;
    const cursor = cursors[sessionId] ?? 0;

    if (cursor < fileBytelen) {
      hasNewContent = true;
    }

    sessions.push({ filePath, sessionId, fileBytelen, cursor });
  }

  if (!hasNewContent) return result;

  const reinforcementEnabled = opts.reinforcement?.enabled !== false && opts.reinforcement != null;
  const passiveBoost = opts.reinforcement?.passiveBoost ?? 0.1;
  const maxConfidence = opts.reinforcement?.maxConfidence ?? 1.0;
  const cosineSimilarityThreshold = opts.reinforcement?.similarityThreshold ?? config.deduplicationThreshold;
  // Convert cosine similarity threshold to L2-based score for vectorDb.search().
  // VectorDB uses score = 1/(1+L2_distance). For normalized vectors, L2 = sqrt(2*(1-cosine)).
  // This conversion ensures the dedup threshold behaves as originally calibrated (issue #499).
  const similarityThreshold = 1 / (1 + Math.sqrt(2 * (1 - cosineSimilarityThreshold)));

  const prompt = loadPrompt("passive-observer");

  // In-memory dedup pool for dry-run mode (Issue #499): during dry-run, facts are not written
  // to LanceDB, so vectorDb.search() cannot find facts extracted earlier in the same batch.
  // This array tracks embeddings of facts that would be stored in the current run, enabling
  // intra-batch deduplication so dry-run accurately previews real-run behavior.
  const dryRunVectors: number[][] = [];

  // In-memory dedup pool for non-dry-run mode: when vectorDb.store() fails, the fact is
  // committed to SQLite but not to LanceDB. This array provides a fallback intra-batch
  // dedup mechanism so subsequent identical facts within the same batch are still detected.
  // Track fact IDs alongside vectors to enable confidence reinforcement (Issue #147).
  const recentVectors: Array<{ vector: number[]; factId: string }> = [];

  // ---------------------------------------------------------------------------
  // Phase 3: process each session that has new content.
  // ---------------------------------------------------------------------------
  // Progress is throttled to the same cadence as the orchestrator's per-step heartbeat (#2026's
  // ORCHESTRATOR_STEP_HEARTBEAT_MS) so a large multi-agent backlog logs a couple dozen lines over
  // the default 15-minute step budget instead of one line per session (#2032).
  let lastProgressLogMs = 0;
  for (const [sessionIdx, { filePath, sessionId, fileBytelen, cursor }] of sessions.entries()) {
    if (maintenanceRunDeadlineReached()) {
      // Deadline stops mid-run are counted as an error so the caller's summary (and
      // assertPassiveObserverSummaryDoesNotBlock) surface a truncated run as a failure
      // instead of a silent "ok" that hides unprocessed sessions (#2032).
      result.errors++;
      logger.warn(
        "memory-hybrid: passive-observer — maintenance run deadline reached; stopping session scan " +
          `(processed ${sessionIdx}/${sessions.length} sessions, sessionsScanned=${result.sessionsScanned}, ` +
          `chunksProcessed=${result.chunksProcessed}, factsStored=${result.factsStored})`,
      );
      break;
    }
    if (cursor >= fileBytelen) continue; // Nothing new
    const progressNowMs = Date.now();
    if (lastProgressLogMs === 0 || progressNowMs - lastProgressLogMs >= PASSIVE_OBSERVER_PROGRESS_LOG_INTERVAL_MS) {
      lastProgressLogMs = progressNowMs;
      logger.info(
        `memory-hybrid: passive-observer — progress: session ${sessionIdx + 1}/${sessions.length} (${sessionId}) ` +
          `chunksProcessed=${result.chunksProcessed} factsExtracted=${result.factsExtracted} factsStored=${result.factsStored}`,
      );
    }

    let rawBuf: Buffer;
    let segmentEnd = fileBytelen;
    try {
      const maxBytes = Math.min(MAX_JSONL_BYTES_PER_RUN, Math.max(200_000, config.maxCharsPerChunk * 8));
      const endOffset = Math.min(fileBytelen, cursor + maxBytes);
      const length = endOffset - cursor;
      if (length <= 0) continue;
      const handle = await open(filePath, "r");
      try {
        rawBuf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(rawBuf, 0, length, cursor);
        if (bytesRead === 0) {
          continue;
        }
        if (bytesRead < length) {
          rawBuf = rawBuf.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
      const lastNewlineIdx = rawBuf.lastIndexOf(0x0a);
      if (lastNewlineIdx === -1 && endOffset < fileBytelen) {
        logger.warn(`memory-hybrid: passive-observer — skipping oversized JSONL line in session ${sessionId}`);
        cursors[sessionId] = endOffset;
        cursorsChanged = true;
        continue;
      }
      const sliceEnd = lastNewlineIdx === -1 ? rawBuf.length : lastNewlineIdx + 1;
      rawBuf = rawBuf.subarray(0, sliceEnd);
      segmentEnd = cursor + sliceEnd;
    } catch (err) {
      if (isEnoent(err)) {
        // File was pruned by session.maintenance between stat and open — skip silently.
        logger.info(
          `memory-hybrid: passive-observer — session ${sessionId} was pruned between scan and read, skipping`,
        );
        continue;
      }
      logger.warn(`memory-hybrid: passive-observer — failed to read session ${sessionId}: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "passive-observer-read",
        subsystem: "passive-observer",
      });
      result.errors++;
      continue;
    }

    const newContent = rawBuf.toString("utf-8");
    if (!newContent.trim()) {
      cursors[sessionId] = segmentEnd;
      cursorsChanged = true;
      continue;
    }

    // Extract human-readable text from JSONL
    const textBlock = extractTextFromJsonlChunk(newContent);
    if (!textBlock.trim()) {
      cursors[sessionId] = segmentEnd;
      cursorsChanged = true;
      continue;
    }

    // Chunk the text block
    const chunks = chunkTextByChars(textBlock, config.maxCharsPerChunk, Math.floor(config.maxCharsPerChunk * 0.05));

    let chunksAttempted = 0;
    let chunksSucceeded = 0;

    let deadlineStopped = false;

    for (const chunk of chunks) {
      if (maintenanceRunDeadlineReached()) {
        logger.warn(
          `memory-hybrid: passive-observer — maintenance run deadline reached; deferring session ${sessionId}`,
        );
        deadlineStopped = true;
        result.errors++;
        break;
      }
      if (!chunk.trim()) continue;
      chunksAttempted++;
      result.chunksProcessed++;
      // Re-check the throttle here too, not just at the top of the session loop (#2032 follow-up):
      // a single session with many chunks (each a full LLM round-trip via chatCompleteWithRetry
      // plus an embedding call) can otherwise run for its entire duration between two per-session
      // log lines, silently reproducing the "live run indistinguishable from a hung one" problem
      // this progress logging was added to close.
      const chunkProgressNowMs = Date.now();
      if (chunkProgressNowMs - lastProgressLogMs >= PASSIVE_OBSERVER_PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogMs = chunkProgressNowMs;
        logger.info(
          `memory-hybrid: passive-observer — progress: session ${sessionIdx + 1}/${sessions.length} (${sessionId}) ` +
            `chunk ${chunksAttempted}/${chunks.length} chunksProcessed=${result.chunksProcessed} ` +
            `factsExtracted=${result.factsExtracted} factsStored=${result.factsStored}`,
        );
      }

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
          feature: CostFeature.passiveObserver,
          timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(opts.model)),
          signal: getMaintenanceRunAbortSignal(),
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

      chunksSucceeded++;

      const facts = parseObserverResponse(rawResponse, allCategories);
      const filtered = facts.filter((f) => f.importance >= config.minImportance);
      result.factsExtracted += filtered.length;

      for (const fact of filtered) {
        const storedText = prepareMemoryTextForStorage(fact.text, config.maxCharsPerChunk);
        if (!storedText || !isSubstantiveMemoryText(storedText)) continue;
        const storedCategory =
          (prepareMemoryMetadataForStorage(fact.category) as MemoryCategory | undefined) ?? fact.category;
        const identity = isIdentityFact(storedText, opts.agentName);

        // Embed new fact for dedup check
        let vec: number[];
        try {
          vec = await embeddings.embed(storedText);
        } catch (err) {
          logger.warn(
            `memory-hybrid: passive-observer — embed failed for fact: ${storedText.slice(0, 80)}... (${err})`,
          );
          // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
          if (!shouldSuppressEmbeddingError(err)) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "passive-observer-embed",
              severity: "info",
              subsystem: "passive-observer",
            });
          }
          result.errors++;
          continue;
        }

        // Normalize the vector to ensure the L2-to-cosine conversion is valid.
        // The conversion formula (1 / (1 + sqrt(2*(1-cosine)))) assumes unit-length vectors.
        // While OpenAI embeddings are pre-normalized, Ollama and some other providers return
        // unnormalized vectors, causing the L2 distance to be scaled by vector magnitude.
        const normalizedVec = normalizeVector(vec);
        const dedupScope = identity ? "global" : "session";
        const dedupScopeTarget = identity ? null : sessionId;

        // Dedup check via LanceDB ANN search — O(log n) instead of O(n*m) brute-force.
        // Replaces the old recentVectors[] linear scan and eliminates the embedBatch()
        // call on the recent-facts pool. LanceDB is the single source of truth.
        let isDuplicate = false;
        try {
          const dupeResults = await vectorDb.search(normalizedVec, 1, similarityThreshold);
          if (dupeResults.length > 0) {
            const matchedId = dupeResults[0].entry.id;
            const matched = matchedId ? factsDb.getById(matchedId) : null;
            const nowSec = Math.floor(Date.now() / 1000);
            const scopeMatches =
              matched != null &&
              matched.supersededAt == null &&
              (matched.expiresAt == null || matched.expiresAt > nowSec) &&
              (matched.scope ?? "global") === dedupScope &&
              (dedupScope === "global" ? null : (matched.scopeTarget ?? null)) === dedupScopeTarget;
            if (scopeMatches) {
              isDuplicate = true;
              // Confidence reinforcement: boost the matched fact instead of silently skipping (Issue #147)
              if (reinforcementEnabled && !opts.dryRun) {
                if (matchedId) {
                  try {
                    const boosted = factsDb.boostConfidence(matchedId, passiveBoost, maxConfidence);
                    if (boosted) result.factsReinforced++;
                  } catch {
                    // Non-fatal — don't fail passive observer because of boost error
                  }
                }
              }
            }
          }
        } catch {
          // On search failure, proceed without dedup — a few duplicates are acceptable
        }

        // Intra-batch dedup: check against facts stored/attempted in this run.
        // In dry-run mode, vectorDb.store() is never called, so vectorDb.search() won't find
        // facts extracted earlier in the same batch. In non-dry-run mode, if vectorDb.store()
        // fails, the fact is in SQLite but not LanceDB, so vectorDb.search() also won't find it.
        // Compare against dryRunVectors[] (dry-run) or recentVectors[] (non-dry-run) to ensure
        // accurate intra-batch deduplication (Issue #499).
        if (!isDuplicate) {
          if (opts.dryRun) {
            for (const recentVec of dryRunVectors) {
              const cosineSim = dotProductSimilarity(normalizedVec, recentVec);
              if (cosineSim >= cosineSimilarityThreshold) {
                isDuplicate = true;
                break;
              }
            }
          } else {
            for (const recent of recentVectors) {
              const cosineSim = dotProductSimilarity(normalizedVec, recent.vector);
              if (cosineSim >= cosineSimilarityThreshold) {
                isDuplicate = true;
                // Confidence reinforcement: boost the matched fact (Issue #147)
                if (reinforcementEnabled) {
                  try {
                    const boosted = factsDb.boostConfidence(recent.factId, passiveBoost, maxConfidence);
                    if (boosted) result.factsReinforced++;
                  } catch {
                    // Non-fatal — don't fail passive observer because of boost error
                  }
                }
                break;
              }
            }
          }
        }

        if (isDuplicate) continue;

        if (opts.dryRun) {
          logger.info(
            `memory-hybrid: passive-observer [dry-run] would store: ${storedText.slice(0, 60)}... (importance=${fact.importance.toFixed(2)}, category=${storedCategory})`,
          );
          result.factsStored++;
          dryRunVectors.push(normalizedVec);
          continue;
        }

        // Write episodic event FIRST (Issue #150, Layer 1): record before factsDb so that if
        // factsDb fails we still have the event record. If eventLog fails we continue to store
        // the fact — event log unavailability must never block fact writes.
        let eventId: string | null = null;
        if (opts.eventLog) {
          try {
            eventId = opts.eventLog.append({
              sessionId,
              timestamp: nowIso(),
              eventType: categoryToEventType(fact.category),
              content: {
                text: storedText,
                category: storedCategory,
                importance: fact.importance,
                source: "passive-observer",
              },
            });
          } catch {
            // Non-fatal — event log write failure must never block fact storage
          }
        }

        // Identity fact promotion (Issue #306): if this fact describes the agent itself,
        // store it as global/permanent so it persists across sessions.
        if (identity) {
          logger.info(`passive-observer: promoting identity fact to global/permanent: "${storedText.slice(0, 60)}..."`);
        }

        const dedupWindow = opts.dedupWindowMinutes ?? 30;
        const dedupInput = {
          text: storedText,
          entity: null,
          key: null,
          scope: dedupScope,
          scopeTarget: dedupScopeTarget,
        };

        const txResult = runCaptureStoreWithDedupWindow(factsDb, dedupWindow, dedupInput, () =>
          factsDb.storeWithResult({
            text: storedText,
            category: storedCategory,
            importance: identity ? Math.max(fact.importance, 0.9) : fact.importance,
            confidence: 0.6,
            entity: null,
            key: null,
            value: null,
            source: "passive-observer",
            decayClass: identity ? "permanent" : "session",
            scope: identity ? "global" : "session",
            scopeTarget: identity ? undefined : sessionId,
            tags: ["passive-observer"],
            provenanceSession: sessionId,
            extractionMethod: "passive",
            extractionConfidence: fact.importance,
          }),
        );
        if (txResult.skipped) {
          continue;
        }

        const storeResult = txResult.storeResult!;
        if (storeResult.skipped) {
          continue;
        }
        if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
          continue;
        }
        const stored = storeResult.entry;
        await cleanupEvictedVector({
          vectorDb,
          evictedFactId: storeResult.evictedFactId,
          logger,
          context: "passive-observer",
        });

        if (opts.provenanceService && storeResult.newlyStored) {
          try {
            opts.provenanceService.addEdge(stored.id, {
              edgeType: "DERIVED_FROM",
              sourceType: "event_log",
              sourceId: eventId ?? sessionId,
              sourceText: storedText,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "passive-observer-provenance",
              subsystem: "provenance",
              factId: stored.id,
            });
          }
        }

        // Contradiction detection (Issue #142): check for same entity+key with different value.
        // For global/permanent identity facts, pass null scope so detection spans all scopes.
        if (storeResult.newlyStored) {
          factsDb.detectContradictions(stored.id, null, null, null, stored.scope ?? null, stored.scopeTarget ?? null);
        }

        // Store to LanceDB (use normalized vector for consistent L2 distance metric)
        try {
          const vectorText = storeResult.embeddingStale ? stored.text : fact.text;
          const vectorForStore = storeResult.embeddingStale ? await embeddings.embed(stored.text) : normalizedVec;
          await vectorDb.store({
            text: vectorText,
            vector: vectorForStore,
            importance: identity ? Math.max(fact.importance, 0.9) : fact.importance,
            category: fact.category,
            id: stored.id,
          });
          factsDb.setEmbeddingModel(stored.id, embeddings.modelName);
        } catch (err) {
          logger.warn(`memory-hybrid: passive-observer vector store failed: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "passive-observer-vector-store",
            subsystem: "vector",
            factId: stored.id,
          });
        }

        // Track vector for intra-batch dedup: whether vectorDb.store() succeeded or failed,
        // add to recentVectors[] so subsequent identical facts in this batch are detected.
        if (storeResult.newlyStored) {
          recentVectors.push({ vector: normalizedVec, factId: stored.id });
          result.factsStored++;
        }
      }
    }

    if (deadlineStopped) {
      break;
    }

    // Advance cursor only when every attempted chunk in this segment succeeded (or there were none).
    // Partial success must not advance — failed chunks would be skipped permanently.
    if (chunksAttempted === 0 || chunksSucceeded === chunksAttempted) {
      cursors[sessionId] = segmentEnd;
      consecutiveFailures.delete(sessionId);
      cursorsChanged = true;
    } else if (chunksSucceeded === 0) {
      const failures = (consecutiveFailures.get(sessionId) ?? 0) + 1;
      consecutiveFailures.set(sessionId, failures);
      if (failures >= 3) {
        // Advance past the problematic content after 3 consecutive failures to prevent
        // an infinite retry loop that wastes LLM tokens on permanently-bad session files.
        logger.warn(
          `memory-hybrid: passive-observer — advancing cursor for session ${sessionId} after ${failures} consecutive failures`,
        );
        cursors[sessionId] = segmentEnd;
        consecutiveFailures.delete(sessionId);
        cursorsChanged = true;
      }
    }
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
