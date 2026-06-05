/**
 * Unified proposal queue — aggregates persona, crystallization, tool, and procedure-skill backlogs.
 */

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ProcedureEntry } from "../types/memory.js";
import { summarizeSkillProposalValidation } from "./generated-skill-validation.js";
import { buildPendingReviewDigestReport, pendingStorePaths } from "./pending-review-digest.js";

export const DEFAULT_WORKSHOP_MAX_PENDING = 50;

export type UnifiedProposalType = "persona" | "crystallization" | "tool" | "procedure-skill";

export type UnifiedProposalStatus = "pending" | "approved" | "rejected" | "quarantined" | "stale";

export interface UnifiedProposal {
  id: string;
  unifiedKey: string;
  type: UnifiedProposalType;
  title: string;
  status: UnifiedProposalStatus;
  confidence: number;
  createdAt: number;
  targetPath: string | null;
  targetHash: string | null;
  preview: string;
  fullContent?: string;
  evidence: { sessions: string[]; factIds: string[] };
  sourceStore: string;
  actions: {
    approveSupported: boolean;
    rejectSupported: boolean;
    quarantineSupported: boolean;
    reviseSupported: boolean;
    undoSupported: boolean;
  };
  metadata?: Record<string, unknown>;
}

export type UnifiedProposalStores = {
  proposalsDb: ProposalsDB | null;
  crystallizationStore: CrystallizationStore | null;
  toolProposalStore: ToolProposalStore | null;
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
};

export function makeUnifiedKey(type: UnifiedProposalType, storeId: string): string {
  return `${type}:${storeId}`;
}

export function parseUnifiedKey(key: string): { type: UnifiedProposalType; storeId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const type = key.slice(0, idx) as UnifiedProposalType;
  const storeId = key.slice(idx + 1);
  if (!storeId) return null;
  if (type !== "persona" && type !== "crystallization" && type !== "tool" && type !== "procedure-skill") {
    return null;
  }
  return { type, storeId };
}

function truncatePreview(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function isoToUnixSec(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export function countPendingUnifiedProposals(stores: UnifiedProposalStores): number {
  return listUnifiedProposals(stores, { status: "pending" }).length;
}

export function enforceMaxPendingCap(
  stores: UnifiedProposalStores,
  maxPending = DEFAULT_WORKSHOP_MAX_PENDING,
): { ok: true } | { ok: false; error: string; pending: number; maxPending: number } {
  const pending = countPendingUnifiedProposals(stores);
  if (pending >= maxPending) {
    return { ok: false, error: "max_pending_reached", pending, maxPending };
  }
  return { ok: true };
}

export function listUnifiedProposals(
  stores: UnifiedProposalStores,
  opts?: { status?: UnifiedProposalStatus; limit?: number; type?: UnifiedProposalType },
): UnifiedProposal[] {
  const out: UnifiedProposal[] = [];
  const limit = opts?.limit ?? 100;
  const filterStatus = opts?.status;
  const filterType = opts?.type;

  if ((!filterType || filterType === "persona") && stores.cfg.personaProposals.enabled && stores.proposalsDb) {
    for (const p of stores.proposalsDb.list({ status: filterStatus === "pending" ? "pending" : undefined })) {
      const status: UnifiedProposalStatus =
        p.status === "pending"
          ? "pending"
          : p.status === "rejected"
            ? "rejected"
            : p.status === "approved" || p.status === "applied"
              ? "approved"
              : "pending";
      if (filterStatus && status !== filterStatus) continue;
      out.push({
        id: p.id,
        unifiedKey: makeUnifiedKey("persona", p.id),
        type: "persona",
        title: p.title,
        status,
        confidence: p.confidence,
        createdAt: p.createdAt,
        targetPath: p.targetFile,
        targetHash: p.targetHash,
        preview: truncatePreview(`${p.observation}\n${p.suggestedChange}`),
        fullContent: `${p.title}\n\n${p.observation}\n\n${p.suggestedChange}`,
        evidence: { sessions: p.evidenceSessions ?? [], factIds: [] },
        sourceStore: "proposals.db",
        actions: {
          approveSupported: status === "pending",
          rejectSupported: status === "pending",
          quarantineSupported: status === "pending",
          reviseSupported: status === "pending",
          undoSupported: p.status === "applied",
        },
        metadata: { targetFile: p.targetFile },
      });
    }
  }

  if ((!filterType || filterType === "crystallization") && stores.crystallizationStore) {
    const crystalPendingStatuses = filterStatus === "pending" ? (["pending"] as const) : undefined;
    const crystalList = stores.crystallizationStore.list({
      status: crystalPendingStatuses?.[0],
      limit: 200,
    });
    for (const p of crystalList) {
      const isPending = p.status === "drafted" || p.status === "validated";
      const status: UnifiedProposalStatus =
        p.status === "quarantined"
          ? "quarantined"
          : p.status === "rejected"
            ? "rejected"
            : p.status === "approved" || p.status === "installed"
              ? "approved"
              : isPending
                ? "pending"
                : "pending";
      if (filterStatus && status !== filterStatus) continue;
      out.push({
        id: p.id,
        unifiedKey: makeUnifiedKey("crystallization", p.id),
        type: "crystallization",
        title: p.skillName,
        status,
        confidence: p.confidence ?? 0.5,
        createdAt: isoToUnixSec(p.createdAt),
        targetPath: p.outputPath ?? null,
        targetHash: null,
        preview: truncatePreview(p.description ?? p.skillContent ?? ""),
        fullContent: p.skillContent,
        evidence: { sessions: [], factIds: [] },
        sourceStore: "crystallization-proposals.db",
        actions: {
          approveSupported: isPending,
          rejectSupported: isPending,
          quarantineSupported: isPending || p.status === "installed",
          reviseSupported: false,
          undoSupported: false,
        },
        metadata: {
          validation: summarizeSkillProposalValidation(p.validationResult),
          crystallizationStatus: p.status,
        },
      });
    }
  }

  if ((!filterType || filterType === "tool") && stores.toolProposalStore) {
    const toolStatus = filterStatus === "pending" ? "proposed" : undefined;
    for (const p of stores.toolProposalStore.list({ status: toolStatus, limit: 200 })) {
      const status: UnifiedProposalStatus =
        p.status === "proposed"
          ? "pending"
          : p.status === "rejected"
            ? "rejected"
            : p.status === "approved" || p.status === "implemented"
              ? "approved"
              : "pending";
      if (filterStatus && status !== filterStatus) continue;
      out.push({
        id: p.id,
        unifiedKey: makeUnifiedKey("tool", p.id),
        type: "tool",
        title: p.name,
        status,
        confidence: 0.5,
        createdAt: isoToUnixSec(p.createdAt),
        targetPath: null,
        targetHash: null,
        preview: truncatePreview(`${p.description}\n${p.rationale}`),
        fullContent: JSON.stringify(
          {
            name: p.name,
            description: p.description,
            parameters: p.parameters,
            rationale: p.rationale,
            implementationHint: p.implementationHint,
          },
          null,
          2,
        ),
        evidence: { sessions: [], factIds: [] },
        sourceStore: "tool-proposals.db",
        actions: {
          approveSupported: p.status === "proposed",
          rejectSupported: p.status === "proposed",
          quarantineSupported: p.status === "proposed",
          reviseSupported: false,
          undoSupported: false,
        },
      });
    }
  }

  if ((!filterType || filterType === "procedure-skill") && stores.cfg.procedures?.enabled !== false) {
    const threshold = stores.cfg.procedures?.validationThreshold ?? 3;
    const ttlDays = stores.cfg.procedures?.skillTTLDays ?? 30;
    const procedures = stores.factsDb.getProceduresReadyForSkill(threshold, 50, ttlDays);
    for (const proc of procedures) {
      const proposal = buildProcedureSkillProposal(stores, proc, threshold);
      if (filterStatus && proposal.status !== filterStatus) continue;
      out.push(proposal);
    }
  }

  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, limit);
}

function buildProcedureSkillProposal(
  stores: UnifiedProposalStores,
  proc: ProcedureEntry,
  threshold = stores.cfg.procedures?.validationThreshold ?? 3,
): UnifiedProposal {
  return {
    id: proc.id,
    unifiedKey: makeUnifiedKey("procedure-skill", proc.id),
    type: "procedure-skill",
    title: proc.taskPattern ?? proc.id,
    status: "pending",
    confidence: proc.confidence ?? 0.5,
    createdAt: proc.lastValidated ?? proc.updatedAt ?? proc.createdAt ?? 0,
    targetPath: stores.cfg.procedures?.skillsAutoPath ?? "skills/auto",
    targetHash: null,
    preview: truncatePreview(proc.taskPattern ?? proc.id),
    evidence: { sessions: proc.sourceSessions ? [proc.sourceSessions] : [], factIds: [] },
    sourceStore: "facts.procedures",
    actions: {
      approveSupported: true,
      rejectSupported: false,
      quarantineSupported: false,
      reviseSupported: false,
      undoSupported: false,
    },
    metadata: {
      successCount: proc.successCount,
      validationThreshold: threshold,
    },
  };
}

export function inspectUnifiedProposal(
  stores: UnifiedProposalStores,
  unifiedKey: string,
): UnifiedProposal | null {
  const parsed = parseUnifiedKey(unifiedKey);
  if (!parsed) return null;

  if (parsed.type === "procedure-skill") {
    const proc = stores.factsDb.getProcedureById(parsed.storeId);
    if (!proc || proc.promotedToSkill) return null;
    const threshold = stores.cfg.procedures?.validationThreshold ?? 3;
    if (proc.successCount < threshold) return null;
    return buildProcedureSkillProposal(stores, proc, threshold);
  }

  const list = listUnifiedProposals(stores, { type: parsed.type, limit: 500 });
  return list.find((p) => p.id === parsed.storeId) ?? null;
}

export function buildWorkshopDigestReport(stores: UnifiedProposalStores, since?: string) {
  return buildPendingReviewDigestReport({
    cfg: stores.cfg,
    factsDb: stores.factsDb,
    since,
  });
}

export function openWorkshopStoresFromPaths(
  cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  deps: {
    proposalsDb?: ProposalsDB | null;
    crystallizationStore?: CrystallizationStore | null;
    toolProposalStore?: ToolProposalStore | null;
  },
): UnifiedProposalStores {
  return {
    cfg,
    factsDb,
    proposalsDb: deps.proposalsDb ?? null,
    crystallizationStore: deps.crystallizationStore ?? null,
    toolProposalStore: deps.toolProposalStore ?? null,
  };
}

export { pendingStorePaths };
