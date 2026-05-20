/**
 * Cluster near-duplicate procedures before skill promotion (Skill Creator v2).
 */

export type ClusterableProcedureItem = {
  procedure: { id: string; taskPattern: string; successCount: number; confidence: number };
  payload: { skillSlug: string };
};

export type ProcedureClusterResult = {
  /** Best item to promote in this cluster. */
  representative: ClusterableProcedureItem;
  /** Other procedure ids merged into the representative skill. */
  relatedProcedureIds: string[];
  /** Jaccard similarity threshold used. */
  threshold: number;
};

function taskTokens(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Group items with task-pattern Jaccard >= threshold; pick highest successCount per group.
 */
export function clusterProcedureItems(items: ClusterableProcedureItem[], threshold = 0.6): ProcedureClusterResult[] {
  const remaining = [...items];
  const clusters: ProcedureClusterResult[] = [];

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const group = [seed];
    const seedTokens = taskTokens(seed.procedure.taskPattern);
    for (let i = remaining.length - 1; i >= 0; i--) {
      const other = remaining[i]!;
      if (jaccard(seedTokens, taskTokens(other.procedure.taskPattern)) >= threshold) {
        group.push(other);
        remaining.splice(i, 1);
      }
    }
    group.sort((a, b) => {
      const scoreA = a.procedure.successCount * a.procedure.confidence;
      const scoreB = b.procedure.successCount * b.procedure.confidence;
      return scoreB - scoreA;
    });
    const representative = group[0]!;
    const relatedProcedureIds = group.slice(1).map((g) => g.procedure.id);
    clusters.push({ representative, relatedProcedureIds, threshold });
  }
  return clusters;
}

/**
 * Map procedure id → cluster it was merged into (if not representative).
 */
export function buildClusterDeferMap(
  clusters: ProcedureClusterResult[],
): Map<string, { representativeId: string; slug: string }> {
  const defer = new Map<string, { representativeId: string; slug: string }>();
  for (const c of clusters) {
    for (const id of c.relatedProcedureIds) {
      defer.set(id, {
        representativeId: c.representative.procedure.id,
        slug: c.representative.payload.skillSlug,
      });
    }
  }
  return defer;
}
