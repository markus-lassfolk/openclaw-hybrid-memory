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
  /** Session id that produced this fact (basename stem); required for multi-session Dream writes. */
  sourceSessionId?: string | null;
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
  const unique = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
  return {
    sessionIds: unique,
    prevalence: {
      sessions: unique.length,
      agents: unique.length > 0 ? 1 : 0,
    },
    rationale,
  };
}

function resolveAttributedWriteScope(input: {
  sessionIds: string[];
  sourceSessionId?: string | null;
}): { scope: "session" | "agent"; scopeTarget: string; evidenceSessions: string[] } | null {
  const attached = [...new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean))];
  const source = input.sourceSessionId?.trim() || "";
  if (source) {
    if (attached.length > 0 && !attached.includes(source)) return null;
    return { scope: "session", scopeTarget: source, evidenceSessions: [source] };
  }
  if (attached.length === 1) {
    return { scope: "session", scopeTarget: attached[0]!, evidenceSessions: attached };
  }
  if (attached.length === 0) return null;
  // Multi-session without per-fact attribution: never collapse into sessionIds[0].
  return { scope: "agent", scopeTarget: "dream-multi", evidenceSessions: attached };
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
    const write = resolveAttributedWriteScope({
      sessionIds: input.sessionIds,
      sourceSessionId: fact.sourceSessionId,
    });
    if (!write) continue;
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
        scope: write.scope,
        scopeTarget: write.scopeTarget,
      },
      evidence: evidenceForSessions(
        write.evidenceSessions,
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
  if (input.sessionIds.length === 0 && input.writeScope !== "global") {
    return out;
  }
  let scope: "session" | "agent" | "user" | "global" =
    input.writeScope ?? (input.sessionIds.length === 1 ? "session" : "agent");
  let scopeTarget =
    input.writeScopeTarget ??
    (scope === "session"
      ? (input.sessionIds[0] ?? null)
      : scope === "agent" || scope === "user"
        ? (input.sessionIds[0] ?? "dream-multi")
        : null);
  // Never collapse multi-session Dream patterns into sessionIds[0].
  if (scope === "session" && input.sessionIds.length !== 1) {
    scope = "agent";
    scopeTarget = "dream-multi";
  }
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

export type SelfCorrectionProposedFact = {
  text: string;
  category: string;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  tags?: string[];
  sourceSessionId?: string | null;
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
    const write = resolveAttributedWriteScope({
      sessionIds: input.sessionIds,
      sourceSessionId: fact.sourceSessionId,
    });
    if (!write) continue;
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
        scope: write.scope,
        scopeTarget: write.scopeTarget,
      },
      evidence: evidenceForSessions(
        write.evidenceSessions,
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
  /** Optional provenance sessions keyed by source fact id (from FactsDB). */
  sourceProvenanceByFactId?: Record<string, string[]>;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  const allow = new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean));
  if (allow.size === 0) return out;

  for (const merge of input.proposals.slice(0, Math.max(1, Math.floor(DREAM_COMPOSE_CANDIDATE_CAP / 2)))) {
    const text = merge.mergedText?.trim();
    if (!text || merge.sourceFactIds.length < 2) continue;

    const provenance = new Set<string>();
    for (const id of merge.sourceFactIds) {
      for (const p of input.sourceProvenanceByFactId?.[id] ?? []) {
        if (p.trim()) provenance.add(p.trim());
      }
    }
    // Fail closed: every source must be attributable to the allowlist when provenance is known;
    // if no provenance map provided, require merge.scopeTarget / sessionIds intersection via scope.
    if (input.sourceProvenanceByFactId) {
      if (provenance.size === 0 || ![...provenance].some((p) => allow.has(p))) continue;
      if ([...provenance].some((p) => !allow.has(p))) continue;
    } else if (merge.scope === "session" && merge.scopeTarget && !allow.has(merge.scopeTarget)) {
      continue;
    } else if (merge.scope === "session" && !merge.scopeTarget) {
      continue;
    }

    const evidenceSessions = [...provenance].filter((p) => allow.has(p));
    const evidence =
      evidenceSessions.length > 0 ? evidenceSessions : merge.scope === "session" && merge.scopeTarget ? [merge.scopeTarget] : [...allow];

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
        scope: (merge.scope as "global" | "user" | "agent" | "session" | undefined) ?? "agent",
        scopeTarget: merge.scopeTarget ?? null,
      },
      evidence: evidenceForSessions(
        evidence,
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
          scope: (merge.scope as "global" | "user" | "agent" | "session" | undefined) ?? "agent",
          scopeTarget: merge.scopeTarget ?? null,
        },
        targetFactId: sourceId,
        preHash,
        evidence: evidenceForSessions(
          evidence,
          `consolidate delete source ${sourceId} (OCC pinned at propose) for dream ${input.dreamRunId}`,
        ),
        reverse: { op: "noop", payload: { note: "source restore requires backup; consolidate reverse is best-effort" } },
        sortOrder: sortOrder++,
      });
    }
  }
  return out;
}

export type ContradictionProposedResolve = {
  contradictionId: string;
  factIdNew: string;
  factIdOld: string;
  /** Propose-time OCC token for factIdOld (#2175). */
  preHash: string;
  scope?: string | null;
  scopeTarget?: string | null;
  /** Provenance sessions from the facts involved (not Dream attachment stamp). */
  provenanceSessionIds?: string[];
};

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
    getById: (id: string) => {
      supersededAt?: number | null;
      scope?: string | null;
      scopeTarget?: string | null;
      provenanceSession?: string | null;
    } | null | undefined;
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
      const newFact = lookup.getById(pair.factIdNew);
      const provenanceSessionIds = [
        oldFact.provenanceSession,
        newFact?.provenanceSession,
        oldFact.scope === "session" ? oldFact.scopeTarget : null,
        newFact?.scope === "session" ? newFact.scopeTarget : null,
      ]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean);
      out.push({
        ...pair,
        preHash,
        scope: oldFact.scope ?? null,
        scopeTarget: oldFact.scopeTarget ?? null,
        provenanceSessionIds: [...new Set(provenanceSessionIds)],
      });
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
  const allow = new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean));
  for (const pair of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    if (!pair.preHash || !pair.factIdOld) continue;
    const provenance = (pair.provenanceSessionIds ?? []).map((s) => s.trim()).filter(Boolean);
    if (allow.size > 0) {
      if (provenance.length === 0 || !provenance.some((p) => allow.has(p))) continue;
    } else {
      continue;
    }
    const evidenceSessions = provenance.filter((p) => allow.has(p));
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
        scope: (pair.scope as "session" | "agent" | "user" | "global" | undefined) ?? "agent",
        scopeTarget: pair.scopeTarget ?? null,
      },
      evidence: evidenceForSessions(
        evidenceSessions,
        `contradiction dry-run auto-resolvable ${pair.contradictionId} for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "unsupersede", payload: { oldFactId: pair.factIdOld, newFactId: null } },
      sortOrder: sortOrder++,
    });
  }
  return out;
}

