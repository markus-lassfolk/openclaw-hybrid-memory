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

import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { FactsDB } from '../backends/facts-db.js'
import type { VectorDB } from '../backends/vector-db.js'
import type { EmbeddingProvider } from './embeddings.js'
import type OpenAI from 'openai'
import type { MemoryCategory, ReinforcementConfig } from '../config.js'
import { chunkTextByChars } from '../utils/text.js'
import { loadPrompt, fillPrompt } from '../utils/prompt-loader.js'
import { chatCompleteWithRetry, LLMRetryError } from './chat.js'
import { capturePluginError } from './error-reporter.js'
import { normalizeVector, dotProductSimilarity } from './reflection.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PassiveObserverConfig {
  enabled: boolean
  intervalMinutes: number
  model?: string
  maxCharsPerChunk: number
  minImportance: number
  deduplicationThreshold: number
  sessionsDir?: string
}

/** One extracted fact from the LLM response. */
export interface ExtractedFact {
  text: string
  category: string
  importance: number
}

/** Per-session cursor: tracks byte offset into the session file. */
export type SessionCursors = Record<string, number>

export interface ObserverRunResult {
  sessionsScanned: number
  chunksProcessed: number
  factsExtracted: number
  factsStored: number
  factsReinforced: number
  errors: number
}


// ---------------------------------------------------------------------------
// JSONL text extraction
// ---------------------------------------------------------------------------

/** Maximum length per message when building the transcript block. */
const MAX_MSG_LENGTH = 500

/**
 * Extract readable text from a raw JSONL transcript chunk.
 * Pulls user messages and assistant text blocks — skips tool calls and results
 * to keep the prompt focused on natural language content.
 */
export function extractTextFromJsonlChunk(chunk: string): string {
  const lines = chunk.split('\n').filter((l) => l.trim())
  const parts: string[] = []

  for (const line of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== 'object') continue

    const msg = (obj as Record<string, unknown>).message as Record<string, unknown> | undefined
    if (!msg || typeof msg !== 'object') continue

    const role = msg.role as string | undefined
    const rawContent = msg.content

    // Plain string user message
    if (role === 'user' && typeof rawContent === 'string' && rawContent.trim()) {
      parts.push(`user: ${rawContent.trim().slice(0, MAX_MSG_LENGTH)}`)
      continue
    }

    // Plain string assistant message
    if (role === 'assistant' && typeof rawContent === 'string' && rawContent.trim()) {
      parts.push(`assistant: ${rawContent.trim().slice(0, MAX_MSG_LENGTH)}`)
      continue
    }

    if (!Array.isArray(rawContent)) continue

    const blocks = rawContent as Array<Record<string, unknown>>
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const type = block.type as string | undefined

      // User text block
      if (
        role === 'user' &&
        type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim()
      ) {
        parts.push(`user: ${block.text.trim().slice(0, MAX_MSG_LENGTH)}`)
      }

      // Assistant text block (not tool calls)
      if (
        role === 'assistant' &&
        type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim()
      ) {
        parts.push(`assistant: ${block.text.trim().slice(0, MAX_MSG_LENGTH)}`)
      }
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

export const DEFAULT_CURSORS_FILENAME = '.passive-observer-cursors.json'

export function getCursorsPath(dbDir: string): string {
  return join(dbDir, DEFAULT_CURSORS_FILENAME)
}

export async function loadCursors(cursorsPath: string): Promise<SessionCursors> {
  try {
    const raw = await readFile(cursorsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const cursors: SessionCursors = {}
      for (const [k, v] of Object.entries(parsed)) {
        // Skip the reserved _failures key
        if (k === '_failures') continue
        if (typeof v === 'number' && v >= 0) {
          cursors[k] = v
        }
      }
      return cursors
    }
    return {}
  } catch {
    return {}
  }
}

/** Load the consecutive-failure counts from the cursors file (stored under the '_failures' key). */
export async function loadFailureCounts(cursorsPath: string): Promise<Record<string, number>> {
  try {
    const raw = await readFile(cursorsPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const failures = parsed._failures
    if (failures && typeof failures === 'object' && !Array.isArray(failures)) {
      const result: Record<string, number> = {}
      for (const [k, v] of Object.entries(failures as Record<string, unknown>)) {
        if (typeof v === 'number' && v >= 0) result[k] = v
      }
      return result
    }
    return {}
  } catch {
    return {}
  }
}

export async function saveCursors(
  cursorsPath: string,
  cursors: SessionCursors,
  failures?: Record<string, number>,
): Promise<void> {
  const dir = dirname(cursorsPath)
  await mkdir(dir, { recursive: true })
  const payload: Record<string, unknown> = { ...cursors }
  if (failures && Object.keys(failures).length > 0) {
    payload._failures = failures
  }
  await writeFile(cursorsPath, JSON.stringify(payload, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const OBSERVER_TEMPERATURE = 0.15
const OBSERVER_MAX_TOKENS = 1200

/**
 * Parse the LLM JSON response into extracted facts.
 * Expects a JSON array of { text, category, importance } objects.
 */
export function parseObserverResponse(raw: string, categories: string[]): ExtractedFact[] {
  const validCategories = new Set<string>(categories.map((c) => c.toLowerCase()))

  // Extract JSON from response (may be wrapped in markdown code fence)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim()

  let parsed: unknown
  try {
    // Find the JSON array portion
    const start = jsonStr.indexOf('[')
    const end = jsonStr.lastIndexOf(']')
    if (start === -1 || end === -1) return []
    parsed = JSON.parse(jsonStr.slice(start, end + 1))
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const facts: ExtractedFact[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>

    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    if (!text || text.length < 10) continue

    const importanceRaw =
      typeof obj.importance === 'number' ? obj.importance : parseFloat(String(obj.importance))
    // Default to 0.0 when importance is missing/invalid, forcing the LLM to explicitly assign
    // a value above minImportance rather than silently passing the threshold.
    const importance = Number.isFinite(importanceRaw) ? Math.max(0, Math.min(1, importanceRaw)) : 0.0

    const categoryRaw =
      typeof obj.category === 'string' ? obj.category.toLowerCase().trim() : 'fact'
    const category = validCategories.has(categoryRaw) ? categoryRaw : 'fact'

    facts.push({ text, category, importance })
  }
  return facts
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
    model: string
    fallbackModels?: string[]
    dbDir: string
    dryRun?: boolean
    /** Fallback sessions dir from procedures config (used when config.sessionsDir is not set). */
    proceduresSessionsDir?: string
    /** Confidence reinforcement config (Issue #147). When set and enabled, similar facts get confidence boost instead of silent skip. */
    reinforcement?: ReinforcementConfig
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
  }

  const sessionsDir =
    config.sessionsDir ??
    opts.proceduresSessionsDir ??
    join(homedir(), '.openclaw', 'agents', 'main', 'sessions')

  if (!existsSync(sessionsDir)) {
    logger.info(`memory-hybrid: passive-observer — sessions dir not found: ${sessionsDir}`)
    return result
  }

  let filePaths: string[]
  try {
    filePaths = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(sessionsDir, f))
  } catch (err) {
    logger.warn(`memory-hybrid: passive-observer — failed to read sessions dir: ${err}`)
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'passive-observer-readdir',
      subsystem: 'passive-observer',
    })
    result.errors++
    return result
  }

  if (filePaths.length === 0) return result

  const cursorsPath = getCursorsPath(opts.dbDir)
  const cursors = await loadCursors(cursorsPath)
  const failureCounts = await loadFailureCounts(cursorsPath)
  let cursorsChanged = false

  // After this many consecutive LLM failures for the same session content, advance
  // the cursor past it to prevent an infinite retry loop wasting LLM tokens.
  const MAX_CONSECUTIVE_FAILURES = 3

  // ---------------------------------------------------------------------------
  // Phase 1: scan all session files, count sessions, detect whether any have
  // new content.  We use stat() to get file sizes without loading entire files
  // into memory (files are read lazily in Phase 3 only when needed).
  // ---------------------------------------------------------------------------
  interface SessionInfo {
    filePath: string
    sessionId: string
    fileBytelen: number
    cursor: number
  }

  const sessions: SessionInfo[] = []
  let hasNewContent = false

  for (const filePath of filePaths) {
    const sessionId = filePath.replace(/\\/g, '/').split('/').pop()!.replace('.jsonl', '')
    let fileBytelen: number
    try {
      const stats = await stat(filePath)
      fileBytelen = stats.size
    } catch (err) {
      logger.warn(`memory-hybrid: passive-observer — failed to stat session ${sessionId}: ${err}`)
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'passive-observer-stat',
        subsystem: 'passive-observer',
      })
      result.errors++
      continue
    }

    result.sessionsScanned++
    const cursor = cursors[sessionId] ?? 0

    if (cursor < fileBytelen) {
      hasNewContent = true
    }

    sessions.push({ filePath, sessionId, fileBytelen, cursor })
  }

  if (!hasNewContent) return result

  // ---------------------------------------------------------------------------
  // Phase 2: load recent fact vectors for dedup (only once per run, now that
  // we know there is new content to process).
  // Cap at 50 facts and use embedBatch() to avoid sequential API calls.
  // ---------------------------------------------------------------------------
  const recentFacts = factsDb.getRecentFacts(7, { excludeCategories: [] }) // last 7 days
  const recentFactsSlice = recentFacts.slice(0, 50)
  const recentVectors: (number[] | null)[] = []
  const recentFactIds: (string | null)[] = []

  const PHASE2_TIMEOUT_MS = 30_000
  try {
    const batchPromise = embeddings.embedBatch(recentFactsSlice.map((f) => f.text))
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Phase 2 embedding timeout')), PHASE2_TIMEOUT_MS),
    )
    const batchVectors = await Promise.race([batchPromise, timeoutPromise])
    for (let i = 0; i < recentFactsSlice.length; i++) {
      try {
        recentVectors.push(normalizeVector(batchVectors[i]))
        recentFactIds.push(recentFactsSlice[i].id)
      } catch {
        recentVectors.push(null)
        recentFactIds.push(null)
      }
    }
  } catch (err) {
    logger.warn(`memory-hybrid: passive-observer — Phase 2 embedding failed or timed out, dedup disabled: ${err}`)
    // Fill with nulls so dedup is skipped but Phase 3 can still proceed
    for (let i = 0; i < recentFactsSlice.length; i++) {
      recentVectors.push(null)
      recentFactIds.push(null)
    }
  }

  const reinforcementEnabled = opts.reinforcement?.enabled !== false && opts.reinforcement != null
  const passiveBoost = opts.reinforcement?.passiveBoost ?? 0.1
  const maxConfidence = opts.reinforcement?.maxConfidence ?? 1.0
  const similarityThreshold = opts.reinforcement?.similarityThreshold ?? config.deduplicationThreshold

  const prompt = loadPrompt('passive-observer')

  // ---------------------------------------------------------------------------
  // Phase 3: process each session that has new content.
  // ---------------------------------------------------------------------------
  for (const { filePath, sessionId, fileBytelen, cursor } of sessions) {
    if (cursor >= fileBytelen) continue // Nothing new

    let rawBuf: Buffer
    try {
      rawBuf = await readFile(filePath)
    } catch (err) {
      logger.warn(`memory-hybrid: passive-observer — failed to read session ${sessionId}: ${err}`)
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'passive-observer-read',
        subsystem: 'passive-observer',
      })
      result.errors++
      continue
    }

    const newContent = rawBuf.subarray(cursor).toString('utf-8')
    if (!newContent.trim()) {
      cursors[sessionId] = fileBytelen
      cursorsChanged = true
      continue
    }

    // Extract human-readable text from JSONL
    const textBlock = extractTextFromJsonlChunk(newContent)
    if (!textBlock.trim()) {
      cursors[sessionId] = fileBytelen
      cursorsChanged = true
      continue
    }

    // Chunk the text block
    const chunks = chunkTextByChars(
      textBlock,
      config.maxCharsPerChunk,
      Math.floor(config.maxCharsPerChunk * 0.05),
    )

    let anyChunkSucceeded = false

    for (const chunk of chunks) {
      if (!chunk.trim()) continue
      result.chunksProcessed++

      const filledPrompt = fillPrompt(prompt, {
        categories: allCategories.join(', '),
        transcript: chunk,
      })

      let rawResponse: string
      try {
        rawResponse = await chatCompleteWithRetry({
          model: opts.model,
          content: filledPrompt,
          temperature: OBSERVER_TEMPERATURE,
          maxTokens: OBSERVER_MAX_TOKENS,
          openai,
          fallbackModels: opts.fallbackModels ?? [],
          label: 'memory-hybrid: passive-observer',
        })
      } catch (err) {
        logger.warn(`memory-hybrid: passive-observer — LLM failed for session ${sessionId}: ${err}`)
        const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: 'passive-observer-llm',
          subsystem: 'passive-observer',
          retryAttempt,
        })
        result.errors++
        continue
      }

      anyChunkSucceeded = true

      const facts = parseObserverResponse(rawResponse, allCategories)
      const filtered = facts.filter((f) => f.importance >= config.minImportance)
      result.factsExtracted += filtered.length

      for (const fact of filtered) {
        // Embed new fact for dedup check
        let vec: number[]
        try {
          vec = await embeddings.embed(fact.text)
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: 'passive-observer-embed',
            severity: 'info',
            subsystem: 'passive-observer',
          })
          continue
        }

        const normVec = normalizeVector(vec)

        // Dedup check against recent facts — reinforce instead of skip when enabled
        let isDuplicate = false
        for (let ri = 0; ri < recentVectors.length; ri++) {
          const rv = recentVectors[ri]
          if (!rv || rv.length === 0) continue
          if (dotProductSimilarity(normVec, rv) >= similarityThreshold) {
            isDuplicate = true
            // Confidence reinforcement: boost the matched fact instead of silently skipping (Issue #147)
            if (reinforcementEnabled && !opts.dryRun) {
              const matchedId = recentFactIds[ri]
              if (matchedId) {
                try {
                  const boosted = factsDb.boostConfidence(matchedId, passiveBoost, maxConfidence)
                  if (boosted) result.factsReinforced++
                } catch {
                  // Non-fatal — don't fail passive observer because of boost error
                }
              }
            }
            break
          }
        }
        if (isDuplicate) continue

        if (opts.dryRun) {
          logger.info(
            `memory-hybrid: passive-observer [dry-run] would store: ${fact.text.slice(0, 60)}... (importance=${fact.importance.toFixed(2)}, category=${fact.category})`,
          )
          result.factsStored++
          recentVectors.push(normVec)
          recentFactIds.push(null)
          continue
        }

        // Store to SQLite — tag with session scope so facts can be scoped to session lifecycle
        const stored = factsDb.store({
          text: fact.text,
          category: fact.category as MemoryCategory,
          importance: fact.importance,
          entity: null,
          key: null,
          value: null,
          source: 'passive-observer',
          decayClass: 'session',
          scope: 'session',
          scopeTarget: sessionId,
          tags: ['passive-observer'],
        })

        // Store to LanceDB
        try {
          await vectorDb.store({
            text: fact.text,
            vector: vec,
            importance: fact.importance,
            category: fact.category,
            id: stored.id,
          })
        } catch (err) {
          logger.warn(`memory-hybrid: passive-observer vector store failed: ${err}`)
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: 'passive-observer-vector-store',
            subsystem: 'vector',
            factId: stored.id,
          })
        }

        recentVectors.push(normVec)
        recentFactIds.push(stored.id)
        result.factsStored++
      }
    }

    // Advance cursor to end of file only if at least one chunk was successfully processed.
    // On failure, increment the consecutive failure count. After MAX_CONSECUTIVE_FAILURES
    // consecutive failures, advance the cursor anyway to prevent an infinite retry loop.
    if (anyChunkSucceeded) {
      cursors[sessionId] = fileBytelen
      delete failureCounts[sessionId]
      cursorsChanged = true
    } else {
      const failures = (failureCounts[sessionId] ?? 0) + 1
      failureCounts[sessionId] = failures
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn(
          `memory-hybrid: passive-observer — skipping session ${sessionId} after ${failures} consecutive failures (advancing cursor to avoid infinite retry)`,
        )
        cursors[sessionId] = fileBytelen
        delete failureCounts[sessionId]
        cursorsChanged = true
      }
    }
  }

  if (cursorsChanged || Object.keys(failureCounts).length > 0) {
    try {
      await saveCursors(cursorsPath, cursors, failureCounts)
    } catch (err) {
      logger.warn(`memory-hybrid: passive-observer — failed to save cursors: ${err}`)
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'passive-observer-save-cursors',
        subsystem: 'passive-observer',
      })
    }
  }

  return result
}
