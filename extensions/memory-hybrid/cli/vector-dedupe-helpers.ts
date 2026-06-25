import { DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";

export const VECTOR_CANDIDATE_LIMIT = 10;
export const VECTOR_CANDIDATE_OVERFETCH_LIMIT = 50;
export const VECTOR_CANDIDATE_MIN_SCORE = 0;

export type VectorNeighbor = { entry: { id: string }; score: number };
export type VectorCandidate = { id: string; score: number };

export type VectorCandidateFact = {
  supersededAt?: number | null;
  expiresAt?: number | null;
  source?: string | null;
  embeddingModel?: string | null;
  scope?: string | null;
  scopeTarget?: string | null;
};

export function getVectorSearchFailReason(vectorDb: unknown): string | null {
  const getter = (vectorDb as { getLastSearchFailReason?: unknown }).getLastSearchFailReason;
  if (typeof getter !== "function") return null;
  try {
    const reason = getter.call(vectorDb);
    return typeof reason === "string" && reason.length > 0 ? reason : null;
  } catch {
    return null;
  }
}

export function isLiveFact(candidate: { supersededAt?: number | null; expiresAt?: number | null }): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  return candidate.supersededAt == null && (candidate.expiresAt == null || candidate.expiresAt > nowSec);
}

export function mapValidVectorCandidates(neighbors: VectorNeighbor[]): VectorCandidate[] {
  return neighbors
    .map((candidate) => ({
      id: candidate.entry.id,
      score: candidate.score,
    }))
    .filter(
      (candidate) =>
        typeof candidate.id === "string" && candidate.id.length > 0 && Number.isFinite(candidate.score),
    );
}

/** Filter LanceDB neighbours to live distillation facts for write-time dedupe (#1947). */
export function filterDistillVectorCandidates(
  neighbors: VectorNeighbor[],
  factsDb: { getById: (id: string) => VectorCandidateFact | null },
  embeddingModelName: string | null,
  candidateScope = "global",
  candidateScopeTarget: string | null = null,
): VectorCandidate[] {
  return mapValidVectorCandidates(neighbors)
    .filter((candidate) => {
      const live = factsDb.getById(candidate.id);
      return (
        live != null &&
        isLiveFact(live) &&
        live.source === "distillation" &&
        (live.scope ?? "global") === candidateScope &&
        (live.scope === "global" ? null : (live.scopeTarget ?? null)) === candidateScopeTarget &&
        (embeddingModelName == null || live.embeddingModel == null || live.embeddingModel === embeddingModelName)
      );
    })
    .slice(0, VECTOR_CANDIDATE_LIMIT);
}

export type ResolveDistillVectorCandidatesResult = {
  vectorCandidates?: VectorCandidate[];
  vectorSearchDegraded: boolean;
  usedHasDuplicateFallback: boolean;
  skipAsDuplicate: boolean;
};

type VectorDbForDistillDedupe = {
  search: (vector: number[], limit: number, minScore: number) => Promise<VectorNeighbor[]>;
  hasDuplicate: (vector: number[], threshold?: number) => Promise<boolean>;
};

/** Pre-compute vector neighbours for distill store, with LanceDB fallback when search is degraded (#1947). */
export async function resolveDistillVectorCandidates(input: {
  fuzzyDedupe: boolean;
  vector: number[];
  vectorDb: VectorDbForDistillDedupe;
  factsDb: { getById: (id: string) => VectorCandidateFact | null };
  embeddingModelName: string | null;
  candidateScope?: string;
  candidateScopeTarget?: string | null;
  duplicateThreshold?: number;
}): Promise<ResolveDistillVectorCandidatesResult> {
  const none: ResolveDistillVectorCandidatesResult = {
    vectorSearchDegraded: false,
    usedHasDuplicateFallback: false,
    skipAsDuplicate: false,
  };
  if (!input.fuzzyDedupe) return none;

  const threshold = input.duplicateThreshold ?? DISTILL_DEDUP_THRESHOLD;
  const scope = input.candidateScope ?? "global";
  const scopeTarget = input.candidateScopeTarget ?? null;

  try {
    const neighbors = await input.vectorDb.search(
      input.vector,
      VECTOR_CANDIDATE_OVERFETCH_LIMIT,
      VECTOR_CANDIDATE_MIN_SCORE,
    );
    const searchFailReason = getVectorSearchFailReason(input.vectorDb);
    if (searchFailReason) {
      const skipAsDuplicate = await input.vectorDb.hasDuplicate(input.vector, threshold);
      return {
        vectorSearchDegraded: true,
        usedHasDuplicateFallback: true,
        skipAsDuplicate,
      };
    }
    return {
      vectorCandidates: filterDistillVectorCandidates(
        neighbors,
        input.factsDb,
        input.embeddingModelName,
        scope,
        scopeTarget,
      ),
      vectorSearchDegraded: false,
      usedHasDuplicateFallback: false,
      skipAsDuplicate: false,
    };
  } catch {
    const skipAsDuplicate = await input.vectorDb.hasDuplicate(input.vector, threshold);
    return {
      vectorSearchDegraded: true,
      usedHasDuplicateFallback: true,
      skipAsDuplicate,
    };
  }
}

export type StoreDedupeMode = "vector" | "lexical-only" | "mixed";

export function classifyStoreDedupeMode(input: {
  fuzzyDedupe: boolean;
  vectorSearchDegraded: boolean;
  vectorCandidates?: ReadonlyArray<VectorCandidate>;
  usedHasDuplicateFallback: boolean;
  skipAsDuplicate: boolean;
}): StoreDedupeMode {
  if (!input.fuzzyDedupe) return "lexical-only";
  if (input.skipAsDuplicate && input.usedHasDuplicateFallback) return "mixed";
  if (input.vectorSearchDegraded) return "lexical-only";
  if (input.vectorCandidates && input.vectorCandidates.length > 0) return "vector";
  return "lexical-only";
}
