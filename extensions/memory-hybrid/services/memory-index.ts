/**
 * Memory Index Service (Issue #645).
 *
 * Builds a lightweight awareness-layer summary and writes MEMORY_INDEX.md.
 * Runs as part of the nightly dream cycle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import type { MemoryEntry } from "../types/memory.js";
import { detectClusters, type TopicCluster, type ClusterFactLookup } from "./topic-clusters.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { chatCompleteWithRetry } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

const MAX_INDEX_CHARS = 3200;
const MAX_CLUSTERS = 8;
const MAX_DECISIONS = 8;
const MAX_ENTITIES = 10;
const DEFAULT_CLUSTER_MIN_SIZE = 3;

type MemoryIndexFactsDb = ClusterFactLookup & {
  getRecentFacts(days: number, options?: { excludeCategories?: string[] }): MemoryEntry[];
};

export interface MemoryIndexConfig {
  workspaceRoot: string;
  model: string;
  fallbackModels?: string[];
  reflectWindowDays: number;
  clusterMinSize?: number;
}

export interface MemoryIndexResult {
  generated: boolean;
  path: string;
  usedLlm: boolean;
  clusters: number;
  decisions: number;
  entities: number;
}

type DecisionDigest = { id: string; date: string; text: string };
type EntityDigest = { entity: string; count: number; lastSeen: number; importance: number };

function shortId(id: string): string {
  return id.slice(0, 8);
}

function toIsoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function clampText(text: string, max = 90): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function importanceBand(importance: number): "low" | "medium" | "high" {
  if (importance >= 0.8) return "high";
  if (importance >= 0.5) return "medium";
  return "low";
}

function clusterLastActive(cluster: TopicCluster, factsDb: ClusterFactLookup): number {
  let latest = 0;
  for (const id of cluster.factIds) {
    const fact = factsDb.getById(id);
    if (!fact) continue;
    const ts = fact.sourceDate ?? fact.createdAt;
    if (ts > latest) latest = ts;
  }
  return latest;
}

function summarizeDecisions(recentFacts: MemoryEntry[]): DecisionDigest[] {
  const decisionFacts = recentFacts
    .filter((f) => f.category === "decision" || (Array.isArray(f.tags) && f.tags.includes("decision")))
    .sort((a, b) => (b.sourceDate ?? b.createdAt) - (a.sourceDate ?? a.createdAt));
  const unique = new Set<string>();
  const out: DecisionDigest[] = [];
  for (const fact of decisionFacts) {
    const key = fact.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (unique.has(key)) continue;
    unique.add(key);
    out.push({
      id: fact.id,
      date: toIsoDate(fact.sourceDate ?? fact.createdAt),
      text: clampText(fact.text, 110),
    });
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

function summarizeEntities(recentFacts: MemoryEntry[]): EntityDigest[] {
  const byEntity = new Map<string, { count: number; lastSeen: number; importanceSum: number }>();
  for (const fact of recentFacts) {
    const entity = fact.entity?.trim();
    if (!entity) continue;
    const current = byEntity.get(entity) ?? { count: 0, lastSeen: 0, importanceSum: 0 };
    current.count += 1;
    current.lastSeen = Math.max(current.lastSeen, fact.sourceDate ?? fact.createdAt);
    current.importanceSum += fact.importance ?? 0.5;
    byEntity.set(entity, current);
  }
  return [...byEntity.entries()]
    .map(([entity, meta]) => ({
      entity,
      count: meta.count,
      lastSeen: meta.lastSeen,
      importance: meta.importanceSum / Math.max(1, meta.count),
    }))
    .sort((a, b) => {
      const scoreA = a.count + a.importance;
      const scoreB = b.count + b.importance;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return b.lastSeen - a.lastSeen;
    })
    .slice(0, MAX_ENTITIES);
}

function deterministicIndex(
  generatedAt: string,
  clusters: TopicCluster[],
  factsDb: ClusterFactLookup,
  decisions: DecisionDigest[],
  entities: EntityDigest[],
): string {
  const lines: string[] = [];
  lines.push("# MEMORY_INDEX");
  lines.push("");
  lines.push(`_Auto-generated: ${generatedAt}_`);
  lines.push("");
  lines.push("## Active Clusters");
  if (clusters.length === 0) {
    lines.push("- none detected");
  } else {
    for (const cluster of clusters.slice(0, MAX_CLUSTERS)) {
      const lastActive = clusterLastActive(cluster, factsDb);
      lines.push(
        `- cluster: ${cluster.label} [${shortId(cluster.id)}], ${cluster.factCount} facts, last active ${toIsoDate(lastActive || cluster.updatedAt)}`,
      );
    }
  }
  lines.push("");
  lines.push("## Recent Decisions");
  if (decisions.length === 0) {
    lines.push("- none in recent window");
  } else {
    for (const decision of decisions) {
      lines.push(`- ${decision.date}: ${decision.text} (fact:${shortId(decision.id)})`);
    }
  }
  lines.push("");
  lines.push("## Key Entities");
  if (entities.length === 0) {
    lines.push("- none in recent window");
  } else {
    for (const entity of entities) {
      lines.push(
        `- ${entity.entity}: type=entity, last seen ${toIsoDate(entity.lastSeen)}, importance=${importanceBand(entity.importance)} (${entity.count} refs)`,
      );
    }
  }
  lines.push("");
  lines.push("<!-- index-policy: summary-only; references by cluster/fact ID; ~500-token target -->");
  return lines.join("\n");
}

function trimIndex(markdown: string): string {
  if (markdown.length <= MAX_INDEX_CHARS) return markdown;
  return `${markdown.slice(0, MAX_INDEX_CHARS - 44).trimEnd()}\n\n<!-- truncated: size budget enforced -->`;
}

function hasRequiredSections(markdown: string): boolean {
  return (
    markdown.includes("## Active Clusters") &&
    markdown.includes("## Recent Decisions") &&
    markdown.includes("## Key Entities")
  );
}

export async function generateMemoryIndex(
  factsDb: MemoryIndexFactsDb,
  openai: OpenAI,
  config: MemoryIndexConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<MemoryIndexResult> {
  const path = join(config.workspaceRoot, "MEMORY_INDEX.md");
  const generatedAt = new Date().toISOString();
  const clusterResult = detectClusters(factsDb, {
    minClusterSize: config.clusterMinSize ?? DEFAULT_CLUSTER_MIN_SIZE,
  });
  const clusters = clusterResult.clusters.slice(0, MAX_CLUSTERS);
  const recentFacts = factsDb.getRecentFacts(Math.max(1, Math.min(90, config.reflectWindowDays)), {
    excludeCategories: [],
  });
  const decisions = summarizeDecisions(recentFacts);
  const entities = summarizeEntities(recentFacts);

  const deterministic = deterministicIndex(generatedAt, clusters, factsDb, decisions, entities);
  let finalIndex = deterministic;
  let usedLlm = false;

  const clusterLines =
    clusters.length === 0
      ? "- none"
      : clusters
          .map((cluster) => {
            const lastActive = clusterLastActive(cluster, factsDb);
            return `- id:${shortId(cluster.id)} label:${cluster.label} facts:${cluster.factCount} last_active:${toIsoDate(lastActive || cluster.updatedAt)}`;
          })
          .join("\n");
  const decisionLines =
    decisions.length === 0
      ? "- none"
      : decisions.map((d) => `- ${d.date} | fact:${shortId(d.id)} | ${d.text}`).join("\n");
  const entityLines =
    entities.length === 0
      ? "- none"
      : entities
          .map((e) => `- ${e.entity} | refs:${e.count} | last_seen:${toIsoDate(e.lastSeen)} | importance:${importanceBand(e.importance)}`)
          .join("\n");

  try {
    const prompt = fillPrompt(loadPrompt("memory-index"), {
      generated_at: generatedAt,
      cluster_data: clusterLines,
      decision_data: decisionLines,
      entity_data: entityLines,
    });
    const llmIndex = await chatCompleteWithRetry({
      model: config.model,
      openai,
      content: prompt,
      temperature: 0.2,
      maxTokens: 700,
      fallbackModels: config.fallbackModels ?? [],
      label: "memory-hybrid: memory-index",
    });
    const cleaned = llmIndex.trim();
    if (cleaned.length > 0 && hasRequiredSections(cleaned)) {
      finalIndex = cleaned;
      usedLlm = true;
    }
  } catch (err) {
    logger.warn(`memory-hybrid: memory-index — LLM synthesis failed, using deterministic fallback: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "memory-index-llm",
      subsystem: "reflection",
    });
  }

  const safeOutput = trimIndex(finalIndex);
  mkdirSync(config.workspaceRoot, { recursive: true });
  writeFileSync(path, safeOutput, "utf-8");
  logger.info(
    `memory-hybrid: memory-index — wrote ${path} (clusters=${clusters.length}, decisions=${decisions.length}, entities=${entities.length}, llm=${usedLlm ? "yes" : "no"})`,
  );

  return {
    generated: true,
    path,
    usedLlm,
    clusters: clusters.length,
    decisions: decisions.length,
    entities: entities.length,
  };
}

