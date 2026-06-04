/**
 * Memory Compression & Summarization Service
 * Implements smart memory consolidation and multi-level summaries
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";

export interface CompressionConfig {
  /** Minimum similarity threshold for clustering (0-1) */
  clusterThreshold: number;
  /** Maximum facts per cluster */
  maxClusterSize: number;
  /** Minimum facts required to trigger compression */
  minFactsForCompression: number;
  /** LLM model to use for summarization */
  llmModel?: string;
  /** Whether to preserve original facts after compression */
  preserveOriginals: boolean;
  /** Time window for compression (in days) */
  timeWindowDays?: number;
}

export interface FactCluster {
  id: string;
  facts: Array<{ id: string; text: string; importance: number }>;
  centroid: number[];
  avgImportance: number;
  category: string;
  size: number;
}

export interface CompressionResult {
  clustersCreated: number;
  factsCompressed: number;
  summariesGenerated: number;
  spaceReduction: number; // Percentage
  tokensReduced: number;
  report: {
    clusters: FactCluster[];
    summaries: Array<{
      clusterId: string;
      summary: string;
      originalFactCount: number;
    }>;
  };
}

export interface SummaryLevel {
  level: "brief" | "detailed" | "full";
  maxTokens: number;
  includeMetadata: boolean;
}

/**
 * Memory Compression Service
 * Clusters related facts and generates multi-level summaries
 */
export class MemoryCompressionService {
  constructor(
    private factsDb: FactsDB,
    _vectorDb: VectorDB | undefined,
    private config: CompressionConfig,
  ) {}

  /**
   * Compress memories by clustering and summarizing related facts
   */
  async compressMemories(options?: {
    category?: string;
    olderThan?: number;
    scope?: string;
  }): Promise<CompressionResult> {
    // Get facts to compress
    let facts = this.factsDb.getAll();

    // Apply filters
    if (options?.category) {
      facts = facts.filter((f) => f.category === options.category);
    }
    if (options?.olderThan) {
      facts = facts.filter((f) => f.createdAt < options.olderThan!);
    }
    if (options?.scope) {
      facts = facts.filter((f) => f.scope === options.scope);
    }

    // Filter out already superseded facts
    facts = facts.filter((f) => !f.supersededBy);

    if (facts.length < this.config.minFactsForCompression) {
      return {
        clustersCreated: 0,
        factsCompressed: 0,
        summariesGenerated: 0,
        spaceReduction: 0,
        tokensReduced: 0,
        report: { clusters: [], summaries: [] },
      };
    }

    // Cluster similar facts
    const clusters = await this.clusterFacts(facts);

    // Generate summaries for each cluster
    const summaries = await this.generateClusterSummaries(clusters);

    // Store summaries and supersede original facts
    let factsCompressed = 0;
    let tokensReduced = 0;

    for (const summary of summaries) {
      const cluster = clusters.find((c) => c.id === summary.clusterId);
      if (!cluster) continue;

      // Calculate token reduction
      const originalTokens = cluster.facts.reduce((sum, f) => sum + this.estimateTokens(f.text), 0);
      const summaryTokens = this.estimateTokens(summary.summary);
      tokensReduced += originalTokens - summaryTokens;

      // Store summary as a new fact
      const summaryFact = {
        text: summary.summary,
        category: cluster.category,
        importance: cluster.avgImportance,
        confidence: 0.9, // Slightly lower since it's a summary
        decayClass: "durable" as const,
        tags: ["summary", "compressed"],
        source: "compression-service",
        entity: null,
        key: null,
        value: null,
        provenanceJson: JSON.stringify({
          compressionClusterId: cluster.id,
          originalFactCount: cluster.facts.length,
          compressionDate: Date.now(),
        }),
      };

      const storeResult = this.factsDb.storeWithResult(summaryFact);

      if (storeResult.skipped || storeResult.newlyStored === false) {
        continue;
      }
      const storedSummary = storeResult.entry;

      // Supersede original facts if configured
      if (!this.config.preserveOriginals) {
        for (const fact of cluster.facts) {
          const original = this.factsDb.getById(fact.id);
          if (original) {
            this.factsDb.supersede(original.id, storedSummary.id);
            factsCompressed++;
          }
        }
      }
    }

    const spaceReduction = facts.length > 0 ? (factsCompressed / facts.length) * 100 : 0;

    return {
      clustersCreated: clusters.length,
      factsCompressed,
      summariesGenerated: summaries.length,
      spaceReduction,
      tokensReduced,
      report: { clusters, summaries },
    };
  }

  /**
   * Cluster facts deterministically until stable vector retrieval is exposed here.
   */
  private async clusterFacts(
    facts: Array<{ id: string; text: string; category: string; importance: number }>,
  ): Promise<FactCluster[]> {
    // Do not fabricate/randomize embeddings: non-deterministic clusters are worse
    // than a deterministic fallback. Vector-aware clustering can be reintroduced
    // once this service can read persisted vectors by fact id.
    return this.clusterByCategory(facts);
  }

  /**
   * Fallback clustering by category when vectors unavailable
   */
  private clusterByCategory(
    facts: Array<{ id: string; text: string; category: string; importance: number }>,
  ): FactCluster[] {
    const categoryMap = new Map<string, typeof facts>();

    for (const fact of facts) {
      const existing = categoryMap.get(fact.category) || [];
      existing.push(fact);
      categoryMap.set(fact.category, existing);
    }

    const clusters: FactCluster[] = [];

    for (const [category, categoryFacts] of categoryMap.entries()) {
      // Split large categories into smaller clusters
      for (let i = 0; i < categoryFacts.length; i += this.config.maxClusterSize) {
        const chunk = categoryFacts.slice(i, i + this.config.maxClusterSize);
        if (chunk.length > 1) {
          clusters.push({
            id: crypto.randomUUID(),
            facts: chunk,
            centroid: [],
            avgImportance: chunk.reduce((sum, f) => sum + f.importance, 0) / chunk.length,
            category,
            size: chunk.length,
          });
        }
      }
    }

    return clusters;
  }

  /**
   * Generate summaries for clusters using LLM
   */
  private async generateClusterSummaries(clusters: FactCluster[]): Promise<
    Array<{
      clusterId: string;
      summary: string;
      originalFactCount: number;
    }>
  > {
    const summaries = [];

    for (const cluster of clusters) {
      // Generate summary prompt
      const factsText = cluster.facts.map((f, i) => `${i + 1}. ${f.text}`).join("\n");

      const _prompt = `Summarize the following ${cluster.size} related facts into a single, concise summary that captures the essential information:

${factsText}

Provide a clear, factual summary that preserves the key details. The summary should be self-contained and easier to recall than the individual facts.`;

      // TODO: Call actual LLM service
      // For now, create a simple concatenation
      const summary = this.generateSimpleSummary(cluster);

      summaries.push({
        clusterId: cluster.id,
        summary,
        originalFactCount: cluster.size,
      });
    }

    return summaries;
  }

  /**
   * Generate a simple summary without LLM (fallback)
   */
  private generateSimpleSummary(cluster: FactCluster): string {
    if (cluster.size === 2) {
      return `${cluster.facts[0].text} Additionally, ${cluster.facts[1].text.toLowerCase()}`;
    }

    const prefix = `Summary of ${cluster.size} ${cluster.category} facts: `;
    const items = cluster.facts.map((f, i) => {
      if (i === 0) return f.text;
      if (i === cluster.size - 1) return `and ${f.text.toLowerCase()}`;
      return f.text.toLowerCase();
    });

    return prefix + items.join("; ");
  }

  /**
   * Create multi-level summary of a fact
   */
  async createMultiLevelSummary(factId: string): Promise<{
    brief: string;
    detailed: string;
    full: string;
  }> {
    const fact = this.factsDb.getById(factId);
    if (!fact) {
      throw new Error(`Fact not found: ${factId}`);
    }

    const full = fact.text;

    // Brief: First sentence or 50 chars
    const brief = this.extractBrief(full);

    // Detailed: First 150 chars or first paragraph
    const detailed = this.extractDetailed(full);

    return { brief, detailed, full };
  }

  private extractBrief(text: string): string {
    const firstSentence = text.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].trim();
    }
    return text.substring(0, 50) + (text.length > 50 ? "..." : "");
  }

  private extractDetailed(text: string): string {
    const firstPara = text.split("\n\n")[0];
    if (firstPara.length <= 150) {
      return firstPara;
    }
    return `${text.substring(0, 150)}...`;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}
