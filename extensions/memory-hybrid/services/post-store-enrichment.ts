/**
 * Universal at-formation enrichment: every genuinely NEW fact gets its neighbors, no matter which
 * path wrote it.
 *
 * Auto-linking used to run only in the memory_store tool, so auto-capture, distill, reflection,
 * consolidation, CLI, and GraphQL facts entered the graph edgeless. This subscriber listens to the
 * factStored bus event — emitted at the single store choke point, only for newlyStored rows — and
 * runs the SAME semantic + entity auto-linking asynchronously (queued, budget-capped, one at a
 * time) so no write path pays for it inline. The tool path keeps its inline linking (it holds the
 * freshly computed embedding vector) and claims its ids here so nothing double-links.
 *
 * Also chains PRECEDED_BY temporal edges ("edges carry across time"): consecutive facts formed in
 * the same provenance session link newest→previous at strength 0.3, giving recall a causal/temporal
 * trail to walk. PRECEDED_BY is excluded from Hebbian strengthening and link decay (RELATED_TO-only
 * mechanics) — time doesn't get stronger or fade.
 */
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { GraphConfig } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";
import { capturePluginError } from "./error-reporter.js";
import { autoLinkSemanticallySimilarFacts } from "./graph-autolink.js";
import { onMemoryEvent } from "./memory-events.js";

interface EnrichmentDeps {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: { graph: GraphConfig };
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
}

const INLINE_CLAIM_TTL_MS = 60_000;
const BUDGET_WINDOW_MS = 60_000;
const SESSION_CHAIN_TTL_MS = 30 * 60_000;

let wired = false;
let deps: EnrichmentDeps | null = null;
const unsubscribes: Array<() => void> = [];
const queue: MemoryEntry[] = [];
let draining = false;
/** Fact ids the memory_store tool already linked inline — skip here to avoid double-linking. */
const inlineClaims = new Map<string, number>();
/** provenanceSession → last stored fact (for PRECEDED_BY chaining). */
const lastStoredBySession = new Map<string, { id: string; at: number }>();
let budgetWindowStart = 0;
let budgetUsed = 0;
let budgetDropsLogged = false;

/** The memory_store tool calls this for facts it auto-links inline (it owns the fresh vector). */
export function claimInlineEnrichment(factId: string): void {
  const now = Date.now();
  inlineClaims.set(factId, now);
  if (inlineClaims.size > 256) {
    for (const [id, ts] of inlineClaims) {
      if (now - ts > INLINE_CLAIM_TTL_MS) inlineClaims.delete(id);
    }
  }
}

function underBudget(perMin: number): boolean {
  const now = Date.now();
  if (now - budgetWindowStart > BUDGET_WINDOW_MS) {
    budgetWindowStart = now;
    budgetUsed = 0;
    budgetDropsLogged = false;
  }
  if (budgetUsed >= perMin) return false;
  budgetUsed++;
  return true;
}

function chainTemporalEdge(entry: MemoryEntry): void {
  const d = deps;
  if (!d || d.cfg.graph.temporalEdges === false) return;
  const sessionKey = entry.provenanceSession ?? null;
  if (!sessionKey) return;
  const now = Date.now();
  const prev = lastStoredBySession.get(sessionKey);
  lastStoredBySession.set(sessionKey, { id: entry.id, at: now });
  if (lastStoredBySession.size > 64) {
    for (const [key, v] of lastStoredBySession) {
      if (now - v.at > SESSION_CHAIN_TTL_MS) lastStoredBySession.delete(key);
    }
  }
  if (!prev || prev.id === entry.id || now - prev.at > SESSION_CHAIN_TTL_MS) return;
  try {
    d.factsDb.createLink(entry.id, prev.id, "PRECEDED_BY", 0.3);
  } catch (err) {
    d.logger.warn(`memory-hybrid: temporal edge failed: ${err}`);
  }
}

async function enrichOne(entry: MemoryEntry): Promise<void> {
  const d = deps;
  if (!d) return;
  const scope = entry.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (entry.scopeTarget ?? null);
  // No vector here (embeddings may not even be configured on this path) — graph-autolink falls
  // back to entity/FTS classification similarity, which needs only SQLite.
  await autoLinkSemanticallySimilarFacts(
    {
      factsDb: d.factsDb,
      vectorDb: d.vectorDb,
      text: entry.text,
      entity: entry.entity ?? null,
      key: entry.key ?? null,
      newFactId: entry.id,
      scope,
      scopeTarget,
    },
    d.cfg.graph,
  );
  d.factsDb.autoLinkEntities(
    entry.id,
    entry.text,
    entry.entity ?? null,
    entry.key ?? null,
    entry.provenanceSession ?? null,
    {
      coOccurrenceWeight: d.cfg.graph.coOccurrenceWeight,
      autoSupersede: d.cfg.graph.autoSupersede,
    },
    entry.scope ?? null,
    entry.scopeTarget ?? null,
  );
}

function drainQueue(): void {
  if (draining) return;
  draining = true;
  setImmediate(async () => {
    try {
      for (;;) {
        const entry = queue.shift();
        if (!entry) break;
        try {
          await enrichOne(entry);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (!/database connection is not open/i.test(e.message)) {
            capturePluginError(e, { operation: "post-store-enrichment", subsystem: "graph-autolink" });
            deps?.logger.warn(`memory-hybrid: post-store auto-link failed: ${e.message}`);
          }
        }
      }
    } finally {
      draining = false;
      if (queue.length > 0) drainQueue();
    }
  });
}

/** Idempotent listener registration; deps are refreshed on every call (re-register safe). */
export function wirePostStoreEnrichment(nextDeps: EnrichmentDeps): void {
  deps = nextDeps;
  if (wired) return;
  wired = true;
  unsubscribes.push(
    onMemoryEvent("factStored", ({ entry }) => {
      const d = deps;
      if (!d || !d.cfg.graph.enabled) return;
      chainTemporalEdge(entry);
      if (!d.cfg.graph.autoLink) return;
      const claimedAt = inlineClaims.get(entry.id);
      if (claimedAt != null && Date.now() - claimedAt < INLINE_CLAIM_TTL_MS) {
        inlineClaims.delete(entry.id);
        return; // the tool path already linked this fact with its fresh vector
      }
      if (!underBudget(d.cfg.graph.autoLinkBudgetPerMin)) {
        if (!budgetDropsLogged) {
          budgetDropsLogged = true;
          d.logger.info?.(
            `memory-hybrid: post-store auto-link budget (${d.cfg.graph.autoLinkBudgetPerMin}/min) reached — skipping the rest of this window`,
          );
        }
        return;
      }
      queue.push(entry);
      drainQueue();
    }),
  );
}

/** Test hygiene: remove listeners and clear all module state. */
export function resetPostStoreEnrichmentForTests(): void {
  for (const off of unsubscribes.splice(0)) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
  wired = false;
  deps = null;
  queue.length = 0;
  draining = false;
  inlineClaims.clear();
  lastStoredBySession.clear();
  budgetWindowStart = 0;
  budgetUsed = 0;
  budgetDropsLogged = false;
}

/** Test helper: resolves when the current queue has fully drained. */
export async function flushPostStoreEnrichmentForTests(): Promise<void> {
  for (;;) {
    if (queue.length === 0 && !draining) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
