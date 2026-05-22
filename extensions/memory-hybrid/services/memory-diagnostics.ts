import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ScopeFilter, SearchResult } from "../types/memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { filterByScope, mergeResults } from "./merge-results.js";

/** Native process metrics captured as evidence of memory pressure (#1551). */
interface LinuxProcMemoryPressureEvidence {
  statusRssKb: number | null;
  statusHwmKb: number | null;
  fdCount: number | null;
  fdTargetGroups: Record<string, number>;
}

type ProcessWithResources = NodeJS.Process & { resources?: { openFd?: () => number } };
const PROC_STATUS_KB_REGEX: Record<"VmRSS" | "VmHWM", RegExp> = {
  VmRSS: /^VmRSS:\s+(\d+)\s+kB$/m,
  VmHWM: /^VmHWM:\s+(\d+)\s+kB$/m,
};

export interface MemoryPressureEvidence {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  openFdCount: number | null;
  linuxProc: LinuxProcMemoryPressureEvidence | null;
  timestamp: number;
}

/**
 * Capture native RSS, heap, and file-descriptor metrics as structured evidence.
 * File descriptors are only available on Linux via process.resources.openFd.
 */
export function captureMemoryPressureEvidence(): MemoryPressureEvidence {
  const mem = process.memoryUsage();
  let openFdCount: number | null = null;
  const resources = (process as ProcessWithResources).resources;
  try {
    if (typeof resources?.openFd === "function") {
      openFdCount = resources.openFd();
    }
  } catch {
    // Not available on all platforms / Node versions — degrade gracefully
  }
  const linuxProc = captureLinuxProcMemoryPressureEvidence();
  if (openFdCount === null && linuxProc?.fdCount !== null) {
    openFdCount = linuxProc!.fdCount;
  }
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
    openFdCount,
    linuxProc,
    timestamp: Date.now(),
  };
}

function captureLinuxProcMemoryPressureEvidence(): LinuxProcMemoryPressureEvidence | null {
  if (process.platform !== "linux") {
    return null;
  }

  let statusRssKb: number | null = null;
  let statusHwmKb: number | null = null;
  let fdCount: number | null = null;
  const fdTargetGroups: Record<string, number> = {};

  try {
    const status = readFileSync("/proc/self/status", "utf8");
    statusRssKb = parseProcStatusKb(status, "VmRSS");
    statusHwmKb = parseProcStatusKb(status, "VmHWM");
  } catch {
    // Degrade gracefully if /proc is unavailable.
  }

  try {
    const fds = readdirSync("/proc/self/fd");
    fdCount = fds.length;
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/self/fd/${fd}`);
        const group = classifyFdTarget(target);
        fdTargetGroups[group] = (fdTargetGroups[group] ?? 0) + 1;
      } catch {
        // Ignore transient FD races while sampling.
      }
    }
  } catch {
    // Degrade gracefully if /proc/self/fd cannot be read.
  }

  return { statusRssKb, statusHwmKb, fdCount, fdTargetGroups };
}

function parseProcStatusKb(status: string, field: "VmRSS" | "VmHWM"): number | null {
  const match = status.match(PROC_STATUS_KB_REGEX[field]);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyFdTarget(target: string): string {
  if (target.startsWith("socket:")) return "socket";
  if (target.startsWith("pipe:")) return "pipe";
  if (target.startsWith("anon_inode:")) return "anon_inode";
  if (target.startsWith("/") || target.startsWith("./")) return "path";
  return "other";
}

type MemoryDiagnosticsResult = {
  markerId: string;
  markerText: string;
  structured: { ok: boolean; count: number };
  semantic: { ok: boolean; count: number; failReason?: string };
  hybrid: { ok: boolean; count: number };
  autoRecall: { ok: boolean; count: number };
  /** Native RSS / heap / FD evidence captured at diagnostic time (#1551). */
  memoryPressure: MemoryPressureEvidence;
};

export async function runMemoryDiagnostics(opts: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  aliasDb?: import("./retrieval-aliases.js").AliasDB | null;
  scopeFilter?: ScopeFilter | null;
  minScore?: number;
  autoRecallLimit?: number;
}): Promise<MemoryDiagnosticsResult> {
  const { factsDb, vectorDb, embeddings, aliasDb, scopeFilter, minScore = 0.3, autoRecallLimit = 10 } = opts;
  const markerText = `__hybrid_mem_diag__ ${randomUUID()}`;
  let markerId = "";

  try {
    const entry = factsDb.store({
      text: markerText,
      category: "fact",
      importance: 0.5,
      source: "diagnostic",
      entity: null,
      key: null,
      value: null,
    });
    markerId = entry.id;

    const vector = await embeddings.embed(markerText);
    await vectorDb.store({
      text: markerText,
      vector,
      importance: entry.importance ?? 0.5,
      category: entry.category,
      id: entry.id,
    });
    factsDb.setEmbeddingModel(entry.id, embeddings.modelName);

    const structuredResults = factsDb.search(markerText, 5, {
      tierFilter: "all",
      scopeFilter: scopeFilter ?? undefined,
    });

    let semanticResults: SearchResult[] = [];
    let semanticFailReason: string | undefined;
    try {
      semanticResults = await vectorDb.search(vector, 5, minScore);
      if (semanticResults.length === 0) {
        semanticFailReason = vectorDb.getLastSearchFailReason() ?? undefined;
      }
      semanticResults = filterByScope(
        semanticResults,
        (id, opts) => factsDb.getById(id, opts),
        scopeFilter ?? undefined,
      );
    } catch (err) {
      semanticFailReason = "search_exception";
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "diagnostics",
        operation: "semantic-search",
      });
    }

    const semanticOk = semanticResults.some((r) => r.entry.id === entry.id);
    if (!semanticOk && semanticFailReason) {
      const dimInfo =
        semanticFailReason === "vector_dim_mismatch"
          ? ` (embedding=${vector.length}, lance=${vectorDb.getVectorDim()})`
          : "";
      capturePluginError(new Error(`Semantic search diagnostic failed: ${semanticFailReason}${dimInfo}`), {
        subsystem: "diagnostics",
        operation: "semantic-search-reason",
      });
    }

    const hybridResults = mergeResults(structuredResults, semanticResults, 5, factsDb);
    const autoRecallResults = mergeResults(structuredResults, semanticResults, autoRecallLimit, factsDb);

    return {
      markerId: entry.id,
      markerText,
      structured: { ok: structuredResults.some((r) => r.entry.id === entry.id), count: structuredResults.length },
      semantic: {
        ok: semanticOk,
        count: semanticResults.length,
        ...(semanticFailReason ? { failReason: semanticFailReason } : {}),
      },
      hybrid: { ok: hybridResults.some((r) => r.entry.id === entry.id), count: hybridResults.length },
      autoRecall: { ok: autoRecallResults.some((r) => r.entry.id === entry.id), count: autoRecallResults.length },
      memoryPressure: captureMemoryPressureEvidence(),
    };
  } finally {
    try {
      if (markerId) {
        factsDb.delete(markerId);
        await vectorDb.delete(markerId);
        aliasDb?.deleteByFactId(markerId);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "diagnostics",
        operation: "cleanup",
      });
    }
  }
}
