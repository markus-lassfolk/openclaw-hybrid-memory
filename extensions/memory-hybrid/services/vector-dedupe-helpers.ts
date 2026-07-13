import { capturePluginError } from "./error-reporter.js";
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
  category?: string | null;
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

function isVectorSchemaValid(vectorDb: unknown): boolean {
  const checker = (vectorDb as { isMemoriesVectorSchemaValid?: unknown }).isMemoriesVectorSchemaValid;
  if (typeof checker !== "function") return true;
  try {
    return checker.call(vectorDb) !== false;
  } catch {
    return true;
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
  candidateCategory: string | null = null,
): VectorCandidate[] {
  return mapValidVectorCandidates(neighbors)
    .filter((candidate) => {
      const live = factsDb.getById(candidate.id);
      return (
        live != null &&
        isLiveFact(live) &&
        live.source === "distillation" &&
        (candidateCategory == null ||
          (live.category ?? "").trim().toLowerCase() === candidateCategory.trim().toLowerCase()) &&
        (live.scope ?? "global") === candidateScope &&
        (live.scope === "global" ? null : (live.scopeTarget ?? null)) === candidateScopeTarget &&
        (embeddingModelName == null || live.embeddingModel == null || live.embeddingModel === embeddingModelName)
      );
    })
    .slice(0, VECTOR_CANDIDATE_LIMIT);
}

/**
 * Filter LanceDB neighbours to live facts of a given source/scope for write-time dedupe (#2027).
 *
 * `applyDedupe`'s vector path (non-project facts) trusts that candidates are already scope/source
 * matched — it only compares cosine score against the threshold. So candidates fed to the store path
 * MUST be pre-filtered here to the same source + scope + scopeTarget as the incoming fact, otherwise a
 * high-similarity fact from a different source/scope could be wrongly treated as a duplicate.
 */
export function filterWriteVectorCandidates(
  neighbors: VectorNeighbor[],
  factsDb: { getById: (id: string) => VectorCandidateFact | null },
  opts: {
    source: string;
    embeddingModelName: string | null;
    candidateScope?: string;
    candidateScopeTarget?: string | null;
  },
): VectorCandidate[] {
  const scope = opts.candidateScope ?? "global";
  const scopeTarget = opts.candidateScopeTarget ?? null;
  return mapValidVectorCandidates(neighbors)
    .filter((candidate) => {
      const live = factsDb.getById(candidate.id);
      return (
        live != null &&
        isLiveFact(live) &&
        (live.source ?? null) === opts.source &&
        (live.scope ?? "global") === scope &&
        (live.scope === "global" ? null : (live.scopeTarget ?? null)) === scopeTarget &&
        (opts.embeddingModelName == null ||
          live.embeddingModel == null ||
          live.embeddingModel === opts.embeddingModelName)
      );
    })
    .slice(0, VECTOR_CANDIDATE_LIMIT);
}

/**
 * Pre-compute vector neighbour candidates for a generic write-time store, source/scope filtered (#2027).
 *
 * Mirrors {@link resolveDistillVectorCandidates} but for arbitrary sources (e.g. the live `memory_store`
 * path). Returns `undefined` candidates (and `vectorSearchDegraded=true`) when the vector search fails,
 * so the caller falls back to lexical-only dedupe rather than throwing.
 */
export async function resolveWriteVectorCandidates(input: {
  fuzzyDedupe: boolean;
  vector: number[];
  vectorDb: { search: (vector: number[], limit: number, minScore: number) => Promise<VectorNeighbor[]> };
  factsDb: { getById: (id: string) => VectorCandidateFact | null };
  source: string;
  embeddingModelName: string | null;
  candidateScope?: string;
  candidateScopeTarget?: string | null;
}): Promise<{ vectorCandidates?: VectorCandidate[]; vectorSearchDegraded: boolean }> {
  if (!input.fuzzyDedupe || !Array.isArray(input.vector) || input.vector.length === 0) {
    return { vectorSearchDegraded: false };
  }
  try {
    const neighbors = await input.vectorDb.search(
      input.vector,
      VECTOR_CANDIDATE_OVERFETCH_LIMIT,
      VECTOR_CANDIDATE_MIN_SCORE,
    );
    if (getVectorSearchFailReason(input.vectorDb)) {
      return { vectorSearchDegraded: true };
    }
    return {
      vectorCandidates: filterWriteVectorCandidates(neighbors, input.factsDb, {
        source: input.source,
        embeddingModelName: input.embeddingModelName,
        candidateScope: input.candidateScope,
        candidateScopeTarget: input.candidateScopeTarget,
      }),
      vectorSearchDegraded: false,
    };
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "resolveWriteVectorCandidates:search",
      severity: "info",
    });
    return { vectorSearchDegraded: true };
  }
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

async function tryHasDuplicateFallback(input: {
  vectorDb: VectorDbForDistillDedupe;
  vector: number[];
  threshold: number;
  neighbors: VectorNeighbor[];
  factsDb: { getById: (id: string) => VectorCandidateFact | null };
  embeddingModelName: string | null;
  candidateScope: string;
  candidateScopeTarget: string | null;
}): Promise<{
  skipAsDuplicate: boolean;
  usedHasDuplicateFallback: boolean;
  vectorCandidates?: VectorCandidate[];
}> {
  if (!isVectorSchemaValid(input.vectorDb)) {
    // hasDuplicate() also returns false when schema is invalid — skip the useless call.
    return { skipAsDuplicate: false, usedHasDuplicateFallback: false };
  }
  const scopedFromNeighbors = filterDistillVectorCandidates(
    input.neighbors,
    input.factsDb,
    input.embeddingModelName,
    input.candidateScope,
    input.candidateScopeTarget,
  );
  if (scopedFromNeighbors.length > 0) {
    return {
      skipAsDuplicate: false,
      usedHasDuplicateFallback: true,
      vectorCandidates: scopedFromNeighbors,
    };
  }
  const hasGlobalDuplicate = await input.vectorDb.hasDuplicate(input.vector, input.threshold);
  if (!hasGlobalDuplicate) {
    return { skipAsDuplicate: false, usedHasDuplicateFallback: true };
  }
  // Unscoped hasDuplicate alone must not skip distill writes — fall back to lexical dedupe at store time.
  return { skipAsDuplicate: false, usedHasDuplicateFallback: true };
}

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
      const fallback = await tryHasDuplicateFallback({
        vectorDb: input.vectorDb,
        vector: input.vector,
        threshold,
        neighbors,
        factsDb: input.factsDb,
        embeddingModelName: input.embeddingModelName,
        candidateScope: scope,
        candidateScopeTarget: scopeTarget,
      });
      return {
        vectorSearchDegraded: true,
        usedHasDuplicateFallback: fallback.usedHasDuplicateFallback,
        skipAsDuplicate: fallback.skipAsDuplicate,
        vectorCandidates: fallback.vectorCandidates,
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
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "resolveDistillVectorCandidates:search",
      severity: "info",
    });
    const fallback = await tryHasDuplicateFallback({
      vectorDb: input.vectorDb,
      vector: input.vector,
      threshold,
      neighbors: [],
      factsDb: input.factsDb,
      embeddingModelName: input.embeddingModelName,
      candidateScope: scope,
      candidateScopeTarget: scopeTarget,
    });
    return {
      vectorSearchDegraded: true,
      usedHasDuplicateFallback: fallback.usedHasDuplicateFallback,
      skipAsDuplicate: fallback.skipAsDuplicate,
      vectorCandidates: fallback.vectorCandidates,
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
