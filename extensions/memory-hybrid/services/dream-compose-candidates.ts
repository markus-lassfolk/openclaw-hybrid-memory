/**
 * Map compose-stage dry-run proposals → dream CandidateEntryInput (#2170 / #2171).
 *
 * Stages return lightweight proposed payloads; this module owns evidence/OCC/reverse plans
 * so runDream stays orchestration-only.
 */

import type { MemoryCategory } from "../types/memory.js";
import type { CandidateEntryInput } from "./dream-candidate-ops.js";
import {
  aclFitsTarget,
  writeScopeWithinBoundary,
  type DreamWriteScope,
} from "./dream-permission.js";
import type { DreamPermissionBoundary } from "../config/types/dreaming.js";

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
  permissionBoundary?: DreamPermissionBoundary;
}): { scope: "session" | "agent"; scopeTarget: string; evidenceSessions: string[] } | null {
  const attached = [...new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean))];
  const source = input.sourceSessionId?.trim() || "";
  let resolved: { scope: "session" | "agent"; scopeTarget: string; evidenceSessions: string[] } | null =
    null;
  if (source) {
    if (attached.length > 0 && !attached.includes(source)) return null;
    resolved = { scope: "session", scopeTarget: source, evidenceSessions: [source] };
  } else if (attached.length === 1) {
    resolved = { scope: "session", scopeTarget: attached[0]!, evidenceSessions: attached };
  } else if (attached.length === 0) {
    return null;
  } else {
    // Multi-session without per-fact attribution: never collapse into sessionIds[0].
    resolved = { scope: "agent", scopeTarget: "dream-multi", evidenceSessions: attached };
  }
  if (!resolved) return null;
  const boundary = input.permissionBoundary;
  if (boundary && !writeScopeWithinBoundary(resolved.scope, boundary)) {
    // Under a session boundary, only single-session attributed writes are admissible.
    if (boundary.targetScope === "session" && resolved.evidenceSessions.length === 1) {
      return {
        scope: "session",
        scopeTarget: resolved.evidenceSessions[0]!,
        evidenceSessions: resolved.evidenceSessions,
      };
    }
    return null;
  }
  return resolved;
}

export function distillProposalsToCandidates(input: {
  proposals: DistillProposedFact[];
  sessionIds: string[];
  dreamRunId: string;
  permissionBoundary?: DreamPermissionBoundary;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const fact of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    const text = fact.text?.trim();
    if (!text) continue;
    const write = resolveAttributedWriteScope({
      sessionIds: input.sessionIds,
      sourceSessionId: fact.sourceSessionId,
      permissionBoundary: input.permissionBoundary,
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
  permissionBoundary?: DreamPermissionBoundary;
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
  const boundary = input.permissionBoundary;
  if (boundary && !writeScopeWithinBoundary(scope, boundary)) {
    if (boundary.targetScope === "session" && input.sessionIds.length === 1) {
      scope = "session";
      scopeTarget = input.sessionIds[0]!;
    } else {
      // Multi-session under session boundary cannot emit an agent write — skip.
      return out;
    }
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
  permissionBoundary?: DreamPermissionBoundary;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  for (const fact of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    const text = fact.text?.trim();
    if (!text) continue;
    const write = resolveAttributedWriteScope({
      sessionIds: input.sessionIds,
      sourceSessionId: fact.sourceSessionId,
      permissionBoundary: input.permissionBoundary,
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
  /**
   * Provenance sessions keyed by source fact id (required for Dream ACL).
   * Missing map → no candidates (fail closed).
   */
  sourceProvenanceByFactId: Record<string, string[]>;
  permissionBoundary?: DreamPermissionBoundary;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  const allow = new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean));
  if (allow.size === 0) return out;

  for (const merge of input.proposals.slice(0, Math.max(1, Math.floor(DREAM_COMPOSE_CANDIDATE_CAP / 2)))) {
    const text = merge.mergedText?.trim();
    if (!text || merge.sourceFactIds.length < 2) continue;

    // Every source must have non-empty provenance fully inside the allowlist (#2174).
    const perSource: string[][] = [];
    let provenanceOk = true;
    for (const id of merge.sourceFactIds) {
      const prov = [...new Set((input.sourceProvenanceByFactId[id] ?? []).map((p) => p.trim()).filter(Boolean))];
      if (prov.length === 0 || prov.some((p) => !allow.has(p))) {
        provenanceOk = false;
        break;
      }
      perSource.push(prov);
    }
    if (!provenanceOk) continue;

    // OCC fail-closed: require propose-time preHash for every source delete.
    if (merge.sourceFactIds.some((id) => !merge.sourcePreHashes[id])) continue;

    const evidenceSessions = [...new Set(perSource.flat())];
    // Clamp write scope to session when a single evidence session; otherwise agent (never invent global).
    let writeScope = evidenceSessions.length === 1 ? ("session" as const) : ("agent" as const);
    let writeTarget = evidenceSessions.length === 1 ? evidenceSessions[0]! : "dream-multi";
    if (input.permissionBoundary && !writeScopeWithinBoundary(writeScope, input.permissionBoundary)) {
      if (input.permissionBoundary.targetScope === "session" && evidenceSessions.length === 1) {
        writeScope = "session";
        writeTarget = evidenceSessions[0]!;
      } else {
        continue;
      }
    }

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
        scope: writeScope,
        scopeTarget: writeTarget,
      },
      evidence: evidenceForSessions(
        evidenceSessions,
        `consolidate dry-run merge of ${merge.sourceFactIds.length} facts for dream ${input.dreamRunId}`,
      ),
      reverse: { op: "delete_fact", payload: {} },
      sortOrder: sortOrder++,
    });

    for (const sourceId of merge.sourceFactIds) {
      const preHash = merge.sourcePreHashes[sourceId]!;
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
          scope: writeScope,
          scopeTarget: writeTarget,
        },
        targetFactId: sourceId,
        preHash,
        evidence: evidenceForSessions(
          evidenceSessions,
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
  /** Dream permission target — used when agent/user/global facts lack provenance sessions. */
  targetScope?: DreamWriteScope;
  personalMode?: boolean;
  permissionBoundary?: DreamPermissionBoundary;
}): CandidateEntryInput[] {
  const out: CandidateEntryInput[] = [];
  let sortOrder = 0;
  const allow = new Set(input.sessionIds.map((s) => s.trim()).filter(Boolean));
  if (allow.size === 0) return out;
  const boundary =
    input.permissionBoundary ??
    ({
      targetScope: input.targetScope ?? "session",
      enforce: true,
      personalMode: input.personalMode === true,
    } satisfies DreamPermissionBoundary);
  const targetScope = boundary.targetScope;

  for (const pair of input.proposals.slice(0, DREAM_COMPOSE_CANDIDATE_CAP)) {
    if (!pair.preHash || !pair.factIdOld) continue;
    const provenance = (pair.provenanceSessionIds ?? []).map((s) => s.trim()).filter(Boolean);
    const factScope: DreamWriteScope =
      pair.scope === "session" || pair.scope === "agent" || pair.scope === "user" || pair.scope === "global"
        ? pair.scope
        : "agent";
    const sessionTarget = typeof pair.scopeTarget === "string" ? pair.scopeTarget.trim() : "";

    // Compose must not emit deletes promote will always reject under the permission boundary.
    if (!writeScopeWithinBoundary(factScope, boundary)) continue;

    let evidenceSessions: string[] = [];
    if (provenance.some((p) => allow.has(p))) {
      evidenceSessions = provenance.filter((p) => allow.has(p));
    } else if (factScope === "session" && sessionTarget && allow.has(sessionTarget)) {
      evidenceSessions = [sessionTarget];
    } else if (
      factScope !== "session" &&
      aclFitsTarget(factScope, targetScope, boundary.personalMode === true)
    ) {
      // Shared/public facts may feed a more-private dream; evidence is the attachment, not invented provenance.
      evidenceSessions = [...allow];
    } else {
      continue;
    }

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
        scope: factScope,
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

