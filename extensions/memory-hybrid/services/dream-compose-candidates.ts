/**
 * Map compose-stage dry-run proposals → dream CandidateEntryInput (#2170 / #2171).
 *
 * Stages return lightweight proposed payloads; this module owns evidence/OCC/reverse plans
 * so runDream stays orchestration-only.
 */

import type { MemoryCategory } from "../types/memory.js";
import type { CandidateEntryInput } from "./dream-candidate-ops.js";

/** Max candidates emitted per compose stage (keeps promote/gate bounded). */
export const DREAM_COMPOSE_CANDIDATE_CAP = 40;

export type DistillProposedFact = {
  text: string;
  category: string;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  source_date?: string | null;
  tags?: string[];
};

export type ReflectProposedPattern = {
  text: string;
};

export type ConsolidateProposedMerge = {
  sourceFactIds: string[];
  mergedText: string;
  category: MemoryCategory | string;
  importance?: number;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  tags?: string[];
  scope?: string;
  scopeTarget?: string | null;
  /** Propose-time OCC tokens keyed by source fact id (#2175). */
  sourcePreHashes: Record<string, string>;
};

function evidenceForSessions(
  sessionIds: string[],
  rationale: string,
): CandidateEntryInput["evidence"] {
  return {
    sessionIds,
    prevalence: {
      sessions: Math.max(1, sessionIds.length || 1),
      agents: 1,
    },
    rationale,
  };
}

export function distillProposalsToCandidates(input: {
  proposals: DistillProposedFact[];
  sessionIds: string[];
  dreamRunId: string;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const fact of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    const text = fact.text?.trim();
    if (!text) continue;
    out.push({
      op: "add",
      payload: {
        text,
        category: (fact.category as MemoryCategory) || "fact",
        importance: 0.6,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? null,
        source: "dream-distill",
        tags: [...(fact.tags ?? []), "dream", "distill"],
        scope: input.sessionIds.length > 0 ? "session" : "agent",
        scopeTarget: input.sessionIds[0] ?? "dream",
      },
      evidence: evidenceForSessions(
        input.sessionIds,
        `distill dry-run proposal for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "delete_fact", payload: {} },
      sortOrder: sortOrder++,
    });
  }
  return out;
}

export function reflectProposalsToCandidates(input: {
  proposals: ReflectProposedPattern[];
  sessionIds: string[];
  dreamRunId: string;
  /** Write scope clamped to dream permission boundary (#2174). Default: session when attached. */
  writeScope?: "session" | "agent" | "user" | "global";
  writeScopeTarget?: string | null;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  const scope: "session" | "agent" | "user" | "global" =
    input.writeScope ?? (input.sessionIds.length > 0 ? "session" : "agent");
  const scopeTarget =
    input.writeScopeTarget ??
    (scope === "session" || scope === "agent" || scope === "user" ? (input.sessionIds[0] ?? "dream") : null);
  for (const pattern of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    const text = pattern.text?.trim();
    if (!text) continue;
    out.push({
      op: "add",
      payload: {
        text,
        category: "pattern",
        importance: 0.7,
        entity: null,
        key: null,
        value: null,
        source: "dream-reflect",
        tags: ["dream", "reflection", "pattern"],
        decayClass: "permanent",
        scope,
        scopeTarget,
      },
      evidence: evidenceForSessions(
        input.sessionIds,
        `reflect dry-run pattern for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "delete_fact", payload: {} },
      sortOrder: sortOrder++,
    });
  }
  return out;
}

export type ContradictionProposedResolve = {
  contradictionId: string;
  factIdNew: string;
  factIdOld: string;
  /** Propose-time OCC token for factIdOld (#2175). */
  preHash: string;
};

export type SelfCorrectionProposedFact = {
  text: string;
  category: string;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  tags?: string[];
};

export function selfCorrectionProposalsToCandidates(input: {
  proposals: SelfCorrectionProposedFact[];
  sessionIds: string[];
  dreamRunId: string;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const fact of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    const text = fact.text?.trim();
    if (!text) continue;
    out.push({
      op: "add",
      payload: {
        text,
        category: (fact.category as MemoryCategory) || "technical",
        importance: 0.65,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? text.slice(0, 200),
        source: "dream-self-correction",
        tags: [...(fact.tags ?? []), "dream", "self-correction"],
        scope: input.sessionIds.length > 0 ? "session" : "agent",
        scopeTarget: input.sessionIds[0] ?? "dream",
      },
      evidence: evidenceForSessions(
        input.sessionIds,
        `self-correction dry-run MEMORY_STORE for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "delete_fact", payload: {} },
      sortOrder: sortOrder++,
    });
  }
  return out;
}

/**
 * Consolidate proposals: one merge (add merged fact) + deletes for sources with OCC preHash.
 */
export function consolidateProposalsToCandidates(input: {
  proposals: ConsolidateProposedMerge[];
  sessionIds: string[];
  dreamRunId: string;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const merge of input.proposals.slice(0, Math.max(1, Math.floor(DREAM_COMPOSE_CANDIDATE_CAP / 2)))) {
    const text = merge.mergedText?.trim();
    if (!text || merge.sourceFactIds.length < 2) continue;

    out.push({
      op: "merge",
      payload: {
        text,
        category: (merge.category as MemoryCategory) || "other",
        importance: merge.importance ?? 0.7,
        entity: merge.entity ?? null,
        key: merge.key ?? null,
        value: merge.value ?? null,
        source: "dream-consolidate",
        tags: [...(merge.tags ?? []), "dream", "consolidated"],
        scope: (merge.scope as "global" | "user" | "agent" | "session" | undefined) ?? "global",
        scopeTarget: merge.scopeTarget ?? null,
      },
      evidence: evidenceForSessions(
        input.sessionIds,
        `consolidate dry-run merge of ${merge.sourceFactIds.length} facts for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "delete_fact", payload: {} },
      sortOrder: sortOrder++,
    });

    for (const sourceId of merge.sourceFactIds) {
      const preHash = merge.sourcePreHashes[sourceId];
      if (!preHash) continue;
      out.push({
        op: "delete",
        payload: {
          text: `delete source ${sourceId} after consolidate merge`,
          category: "other",
          importance: 0,
          entity: null,
          key: null,
          value: null,
          source: "dream-consolidate",
        },
        targetFactId: sourceId,
        preHash,
        evidence: evidenceForSessions(
          input.sessionIds,
          `consolidate delete source ${sourceId} (OCC pinned at propose) for dream ${input.dreamRunId}`,
        ),
        reverse: { op: "noop", payload: { note: "source restore requires backup; consolidate reverse is best-effort" } },
        sortOrder: sortOrder++,
      });
    }
  }
  return out;
}

export type ContradictionResolvePair = {
  contradictionId: string;
  factIdNew: string;
  factIdOld: string;
};

/**
 * Pin OCC preHash for auto-resolvable contradiction deletes.
 * Skip missing / already-superseded facts (fail closed — do not emit stale deletes).
 */
export function pinContradictionResolves(
  pairs: ContradictionResolvePair[],
  lookup: {
    getById: (id: string) => { supersededAt?: number | null } | null | undefined;
    getOccToken: (id: string) => string | null;
  },
): ContradictionProposedResolve[] {
  const out: ContradictionProposedResolve[] = [];
  for (const pair of pairs) {
    try {
      const oldFact = lookup.getById(pair.factIdOld);
      if (!oldFact || oldFact.supersededAt != null) continue;
      const preHash = lookup.getOccToken(pair.factIdOld);
      if (!preHash) continue;
      out.push({ ...pair, preHash });
    } catch {
      // fail closed per pair
    }
  }
  return out;
}

/** Auto-resolvable contradiction pairs → delete older fact with OCC preHash (#2170/#2175). */
export function contradictionProposalsToCandidates(input: {
  proposals: ContradictionProposedResolve[];
  sessionIds: string[];
  dreamRunId: string;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const pair of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    if (!pair.preHash || !pair.factIdOld) continue;
    out.push({
      op: "delete",
      targetFactId: pair.factIdOld,
      preHash: pair.preHash,
      payload: {
        text: `resolve contradiction ${pair.contradictionId} (drop ${pair.factIdOld}, keep ${pair.factIdNew})`,
        category: "preference",
        importance: 0,
        entity: null,
        key: null,
        value: null,
        source: "dream-contradictions",
        tags: ["dream", "contradiction-resolve"],
      },
      evidence: evidenceForSessions(
        input.sessionIds,
        `contradiction dry-run auto-resolvable ${pair.contradictionId} for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "unsupersede", payload: { oldFactId: pair.factIdOld, newFactId: null } },
      sortOrder: sortOrder++,
    });
  }
  return out;
}

