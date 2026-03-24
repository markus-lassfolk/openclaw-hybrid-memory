import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { detectClusters } from "./topic-clusters.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { capturePluginError } from "./error-reporter.js";
import {
  chatCompleteWithRetry,
  LLMRetryError,
  is500Like,
  is404Like,
  isOllamaOOM,
  isConnectionErrorLike,
} from "./chat.js";

const MAX_CLUSTERS = 5;
const MAX_DECISIONS = 5;
const MAX_ENTITIES = 8;
const MAX_PATTERNS = 5;
const MAX_OUTPUT_CHARS = 3200;

export interface MemoryIndexOptions {
  workspaceRoot?: string;
  outputPath?: string;
  model?: string;
  fallbackModels?: string[];
  recentWindowDays?: number;
}

export interface MemoryIndexResult {
  path: string;
  content: string;
  usedFallback: boolean;
}

type MemoryIndexSnapshot = {
  generatedAt: string;
  clusters: Array<{
    label: string;
    factCount: number;
    entityCount: number;
    lastActive: string;
    refs: string[];
  }>;
  recentDecisions: Array<{
    date: string;
    label: string;
    ref: string;
  }>;
  keyEntities: Array<{
    entity: string;
    mentions: number;
    lastSeen: string;
    importance: "high" | "medium" | "low";
  }>;
  recentPatterns: Array<{
    date: string;
    label: string;
    ref: string;
  }>;
};

function toDateLabel(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return "unknown";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function shortRef(id: string): string {
  return id.slice(0, 8);
}

function labelFromEntry(entry: MemoryEntry): string {
  const entity = entry.entity?.trim();
  const key = entry.key?.trim();
  if (entity && key) return `${entity} / ${key}`;
  if (entity) return entity;
  const summary = entry.summary?.trim();
  if (summary && summary !== entry.text.trim()) return summary.split(/\s+/).slice(0, 8).join(" ");
  const words = entry.text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length > 6) return `${words.slice(0, 6).join(" ")}…`;
  if (words.length > 0) return words.join(" ");
  return `${entry.category} note`;
}

function importanceBand(score: number): "high" | "medium" | "low" {
  if (score >= 0.75) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

function takeLiveRecent(entries: MemoryEntry[], limit: number, category?: string): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  return entries
    .filter((entry) => !category || entry.category === category)
    .filter((entry) => !entry.supersededAt)
    .filter((entry) => entry.expiresAt == null || entry.expiresAt > nowSec)
    .slice(0, limit);
}

export function buildMemoryIndexSnapshot(
  factsDb: FactsDB,
  options: Pick<MemoryIndexOptions, "recentWindowDays"> = {},
): MemoryIndexSnapshot {
  const recentWindowDays = Math.min(90, Math.max(1, options.recentWindowDays ?? 30));
  const allFacts = factsDb.getAll();
  const recentCutoffSec = Math.floor(Date.now() / 1000) - recentWindowDays * 86400;
  const recentFacts = allFacts.filter((entry) => (entry.sourceDate ?? entry.createdAt) >= recentCutoffSec);
  const liveFactIds = new Set(allFacts.map((f) => f.id));
  const filteredFactsDb = {
    getAllLinkedFactIds: () => factsDb.getAllLinkedFactIds().filter((id) => liveFactIds.has(id)),
    getAllLinks: () =>
      factsDb.getAllLinks().filter((l) => liveFactIds.has(l.sourceFactId) && liveFactIds.has(l.targetFactId)),
    getById: (id: string) => factsDb.getById(id),
    getByIds: (ids: string[]) => factsDb.getByIds(ids),
  };
  const clusterResult = detectClusters(filteredFactsDb, { minClusterSize: 3 });

  const clusters = clusterResult.clusters.slice(0, MAX_CLUSTERS).map((cluster) => {
    const entries = [...factsDb.getByIds(cluster.factIds).values()];
    const lastActiveSec = entries.reduce((maxSec, entry) => Math.max(maxSec, entry.sourceDate ?? entry.createdAt), 0);
    const entityCount = new Set(entries.map((entry) => entry.entity?.trim()).filter(Boolean)).size;
    return {
      label: cluster.label,
      factCount: cluster.factCount,
      entityCount,
      lastActive: toDateLabel(lastActiveSec),
      refs: cluster.factIds.slice(0, 3).map(shortRef),
    };
  });

  const recentDecisions = takeLiveRecent(factsDb.listFactsByCategory("decision", MAX_DECISIONS * 3), MAX_DECISIONS).map(
    (entry) => ({
      date: toDateLabel(entry.sourceDate ?? entry.createdAt),
      label: labelFromEntry(entry),
      ref: `decision:${shortRef(entry.id)}`,
    }),
  );

  const recentPatterns = [
    ...takeLiveRecent(factsDb.listFactsByCategory("pattern", MAX_PATTERNS * 2), MAX_PATTERNS),
    ...takeLiveRecent(factsDb.listFactsByCategory("rule", MAX_PATTERNS * 2), MAX_PATTERNS),
  ]
    .sort((a, b) => (b.sourceDate ?? b.createdAt) - (a.sourceDate ?? a.createdAt))
    .slice(0, MAX_PATTERNS)
    .map((entry) => ({
      date: toDateLabel(entry.sourceDate ?? entry.createdAt),
      label: labelFromEntry(entry),
      ref: `${entry.category}:${shortRef(entry.id)}`,
    }));

  const entityStats = new Map<string, { mentions: number; lastSeen: number; importanceTotal: number }>();
  for (const entry of recentFacts.length > 0 ? recentFacts : allFacts) {
    const entity = entry.entity?.trim();
    if (!entity) continue;
    const seenAt = entry.sourceDate ?? entry.createdAt;
    const current = entityStats.get(entity) ?? { mentions: 0, lastSeen: 0, importanceTotal: 0 };
    current.mentions += 1;
    current.lastSeen = Math.max(current.lastSeen, seenAt);
    current.importanceTotal += entry.importance ?? 0;
    entityStats.set(entity, current);
  }

  const keyEntities = [...entityStats.entries()]
    .sort((a, b) => {
      if (b[1].mentions !== a[1].mentions) return b[1].mentions - a[1].mentions;
      return b[1].lastSeen - a[1].lastSeen;
    })
    .slice(0, MAX_ENTITIES)
    .map(([entity, stats]) => ({
      entity,
      mentions: stats.mentions,
      lastSeen: toDateLabel(stats.lastSeen),
      importance: importanceBand(stats.importanceTotal / Math.max(1, stats.mentions)),
    }));

  return {
    generatedAt: new Date().toISOString(),
    clusters,
    recentDecisions,
    keyEntities,
    recentPatterns,
  };
}

export function renderMemoryIndexMarkdown(snapshot: MemoryIndexSnapshot): string {
  const clusterLines =
    snapshot.clusters.length > 0
      ? snapshot.clusters.map(
          (cluster) =>
            `- cluster: ${cluster.label}, ${cluster.factCount} facts, ${cluster.entityCount} entities, last active ${cluster.lastActive}, refs ${cluster.refs.join(", ")}`,
        )
      : ["- none"];

  const decisionLines =
    snapshot.recentDecisions.length > 0
      ? snapshot.recentDecisions.map((decision) => `- ${decision.date}: ${decision.label} [${decision.ref}]`)
      : ["- none"];

  const entityLines =
    snapshot.keyEntities.length > 0
      ? snapshot.keyEntities.map(
          (entity) =>
            `- ${entity.entity}: ${entity.mentions} facts, last seen ${entity.lastSeen}, importance ${entity.importance}`,
        )
      : ["- none"];

  const patternLines =
    snapshot.recentPatterns.length > 0
      ? snapshot.recentPatterns.map((pattern) => `- ${pattern.date}: ${pattern.label} [${pattern.ref}]`)
      : ["- none"];

  return [
    "# MEMORY_INDEX",
    "",
    `Auto-generated awareness layer. Updated ${snapshot.generatedAt}.`,
    "",
    "## Active Clusters",
    ...clusterLines,
    "",
    "## Recent Decisions",
    ...decisionLines,
    "",
    "## Key Entities",
    ...entityLines,
    "",
    "## Recent Patterns",
    ...patternLines,
    "",
  ].join("\n");
}

function sanitizeIndexMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.includes("## Active Clusters") || !trimmed.includes("## Recent Decisions")) return "";
  return trimmed.length > MAX_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_OUTPUT_CHARS).trimEnd()}\n` : `${trimmed}\n`;
}

async function synthesizeMemoryIndex(
  snapshot: MemoryIndexSnapshot,
  openai: OpenAI,
  options: Pick<MemoryIndexOptions, "model" | "fallbackModels">,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string | null> {
  if (!options.model) return null;

  const prompt = fillPrompt(loadPrompt("memory-index"), {
    generated_at: snapshot.generatedAt,
    memory_snapshot: JSON.stringify(snapshot, null, 2),
  });

  try {
    const response = await chatCompleteWithRetry({
      model: options.model,
      content: prompt,
      temperature: 0.2,
      maxTokens: 700,
      openai,
      fallbackModels: options.fallbackModels ?? [],
      label: "memory-hybrid: memory-index",
      feature: "reflection",
    });
    return sanitizeIndexMarkdown(response);
  } catch (err) {
    logger.warn(`memory-hybrid: memory-index — synthesis failed, using fallback: ${err}`);
    const error = err instanceof Error ? err : new Error(String(err));
    const isTransient =
      isOllamaOOM(error) ||
      is500Like(error) ||
      is404Like(error) ||
      /timed out|llm request timeout|request was aborted/i.test(error.message) ||
      isConnectionErrorLike(error);
    if (!isTransient) {
      const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
      capturePluginError(error, {
        operation: "memory-index-llm",
        subsystem: "openai",
        retryAttempt,
      });
    }
    return null;
  }
}

function resolveOutputPath(options: Pick<MemoryIndexOptions, "workspaceRoot" | "outputPath">): string {
  if (options.outputPath) return options.outputPath;
  const workspaceRoot = options.workspaceRoot ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
  return join(workspaceRoot, "MEMORY_INDEX.md");
}

export async function writeMemoryIndex(
  factsDb: FactsDB,
  openai: OpenAI,
  options: MemoryIndexOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<MemoryIndexResult> {
  const snapshot = buildMemoryIndexSnapshot(factsDb, options);
  const llmMarkdown = await synthesizeMemoryIndex(snapshot, openai, options, logger);
  const content = llmMarkdown || renderMemoryIndexMarkdown(snapshot);
  const outputPath = resolveOutputPath(options);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf-8");

  logger.info(`memory-hybrid: memory-index — wrote ${outputPath}`);

  return {
    path: outputPath,
    content,
    usedFallback: !llmMarkdown,
  };
}
