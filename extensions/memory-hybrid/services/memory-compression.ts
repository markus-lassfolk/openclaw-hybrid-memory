/**
 * Memory Compression & Summarization Service
 * Implements smart memory consolidation and multi-level summaries
 */

import type { FactsDB } from "../backends/facts-db/facts-db-layer1.js";
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
    private vectorDb: VectorDB | undefined,
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
    console.log("[Compression] Starting memory compression...");

    // Get facts to compress
    let facts = this.factsDb.getAllFacts();

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
      console.log(
        `[Compression] Not enough facts to compress (${facts.length} < ${this.config.minFactsForCompression})`,
      );
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
    console.log(`[Compression] Created ${clusters.length} clusters`);

    // Generate summaries for each cluster
    const summaries = await this.generateClusterSummaries(clusters);
    console.log(`[Compression] Generated ${summaries.length} summaries`);

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
        id: crypto.randomUUID(),
        text: summary.summary,
        category: cluster.category,
        importance: cluster.avgImportance,
        confidence: 0.9, // Slightly lower since it's a summary
        decayClass: "stable" as const,
        tags: ["summary", "compressed"],
        source: "compression-service",
        createdAt: Date.now(),
        metadata: {
          compressionClusterId: cluster.id,
          originalFactCount: cluster.facts.length,
          compressionDate: Date.now(),
        },
      };

      await this.factsDb.store(summaryFact);

      // Supersede original facts if configured
      if (!this.config.preserveOriginals) {
        for (const fact of cluster.facts) {
          const original = this.factsDb.getFactById(fact.id);
          if (original) {
            await this.factsDb.store({
              ...original,
              supersededBy: summaryFact.id,
              updatedAt: Date.now(),
            });
            factsCompressed++;
          }
        }
      }
    }

    const spaceReduction = facts.length > 0 ? (factsCompressed / facts.length) * 100 : 0;

    console.log(`[Compression] Complete: ${factsCompressed} facts compressed into ${summaries.length} summaries`);
    console.log(`[Compression] Token reduction: ${tokensReduced} tokens (~${(tokensReduced / 1000).toFixed(1)}k)`);

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
   * Cluster facts based on semantic similarity
   */
  private async clusterFacts(
    facts: Array<{ id: string; text: string; category: string; importance: number }>,
  ): Promise<FactCluster[]> {
    if (!this.vectorDb) {
      // Fallback to category-based clustering without vectors
      return this.clusterByCategory(facts);
    }

    // Get embeddings for all facts
    const embeddings = new Map<string, number[]>();
    for (const fact of facts) {
      // TODO: Get actual embeddings from vectorDb
      // For now, use random embeddings as placeholder
      embeddings.set(fact.id, this.generateRandomEmbedding());
    }

    // Hierarchical clustering
    const clusters: FactCluster[] = [];
    const assigned = new Set<string>();

    for (const fact of facts) {
      if (assigned.has(fact.id)) continue;

      const factEmbedding = embeddings.get(fact.id);
      if (!factEmbedding) continue;

      // Find similar facts
      const cluster: FactCluster = {
        id: crypto.randomUUID(),
        facts: [fact],
        centroid: factEmbedding,
        avgImportance: fact.importance,
        category: fact.category,
        size: 1,
      };

      assigned.add(fact.id);

      // Add similar facts to cluster
      for (const otherFact of facts) {
        if (assigned.has(otherFact.id)) continue;
        if (cluster.size >= this.config.maxClusterSize) break;

        const otherEmbedding = embeddings.get(otherFact.id);
        if (!otherEmbedding) continue;

        const similarity = this.cosineSimilarity(factEmbedding, otherEmbedding);

        if (similarity >= this.config.clusterThreshold) {
          cluster.facts.push(otherFact);
          cluster.size++;
          assigned.add(otherFact.id);

          // Update centroid and average importance
          cluster.centroid = this.updateCentroid(cluster.centroid, otherEmbedding, cluster.size);
          cluster.avgImportance = (cluster.avgImportance * (cluster.size - 1) + otherFact.importance) / cluster.size;
        }
      }

      // Only keep clusters with multiple facts
      if (cluster.size > 1) {
        clusters.push(cluster);
      }
    }

    return clusters;
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

      const prompt = `Summarize the following ${cluster.size} related facts into a single, concise summary that captures the essential information:

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
    const fact = this.factsDb.getFactById(factId);
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
    return text.substring(0, 150) + "...";
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private updateCentroid(centroid: number[], newVector: number[], clusterSize: number): number[] {
    return centroid.map((val, i) => (val * (clusterSize - 1) + newVector[i]) / clusterSize);
  }

  private generateRandomEmbedding(dimensions = 384): number[] {
    return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}
