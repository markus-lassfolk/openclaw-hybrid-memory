/**
 * Mission Control workshop collectors (Phase 3).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CrystallizationStore } from "../../backends/crystallization-store.js";
import type { FactsDB } from "../../backends/facts-db.js";
import type { ProposalsDB } from "../../backends/proposals-db.js";
import type { ToolProposalStore } from "../../backends/tool-proposal-store.js";
import type { WorkflowStore } from "../../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../../config.js";
import type { ChangeEvent } from "../../services/change-feed.js";
import type { ChangeFeed } from "../../services/change-feed.js";
import { buildChangeRevertContext, revertChangeById } from "../../services/change-feed-revert.js";
import { buildWorkshopDigestReport } from "../../services/unified-proposals.js";
import {
  DEFAULT_WORKSHOP_DASHBOARD_LIST_LIMIT,
  DEFAULT_WORKSHOP_LIST_LIMIT,
  listWorkshopDashboardChangeFeedSessions,
  resolveWorkshopSessionKey,
} from "../../services/workshop-config.js";
import {
  type WorkshopServiceContext,
  withWorkshopDefaults,
  workshopApprove,
  workshopInspect,
  workshopQuarantine,
  workshopReject,
  workshopRevise,
  workshopUndo,
  workshopList,
} from "../../services/workshop-service.js";

export type WorkshopDashboardContext = {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  workflowStore?: WorkflowStore | null;
  resolvedSqlitePath: string;
  changeFeed?: ChangeFeed | null;
  dreamCycleLogDir?: string;
};

function wctx(ctx: WorkshopDashboardContext): WorkshopServiceContext {
  return withWorkshopDefaults({
    cfg: ctx.cfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    changeFeed: ctx.changeFeed ?? null,
    sessionKey: resolveWorkshopSessionKey(ctx.cfg),
  });
}

export function collectWorkshopProposals(ctx: WorkshopDashboardContext) {
  return workshopList(wctx(ctx), {
    status: "pending",
    limit: DEFAULT_WORKSHOP_DASHBOARD_LIST_LIMIT,
    includeUndoable: true,
  });
}

export function collectWorkshopProposalDetail(ctx: WorkshopDashboardContext, unifiedKey: string) {
  return workshopInspect(wctx(ctx), unifiedKey);
}

export async function applyWorkshopProposal(ctx: WorkshopDashboardContext, unifiedKey: string) {
  return workshopApprove(wctx(ctx), unifiedKey);
}

export function rejectWorkshopProposal(ctx: WorkshopDashboardContext, unifiedKey: string, reason?: string) {
  return workshopReject(wctx(ctx), unifiedKey, reason);
}

export function quarantineWorkshopProposal(ctx: WorkshopDashboardContext, unifiedKey: string, reason?: string) {
  return workshopQuarantine(wctx(ctx), unifiedKey, reason);
}

export function reviseWorkshopProposal(ctx: WorkshopDashboardContext, unifiedKey: string, revision: string) {
  return workshopRevise(wctx(ctx), unifiedKey, revision);
}

export function undoWorkshopProposal(
  ctx: WorkshopDashboardContext,
  unifiedKey: string,
  opts?: { changeEventId?: string },
) {
  return workshopUndo(wctx(ctx), unifiedKey, opts);
}

export function collectWorkshopDigest(ctx: WorkshopDashboardContext) {
  return buildWorkshopDigestReport(wctx(ctx));
}

export function collectWorkshopChanges(ctx: WorkshopDashboardContext, limit = DEFAULT_WORKSHOP_LIST_LIMIT) {
  if (!ctx.changeFeed || ctx.cfg.liveChangeFeed?.enabled === false) return [];
  const recentAll = ctx.changeFeed.listRecent({ limit: Math.min(200, limit * 4), status: "active" });
  const recentSessionKeys = new Set<string>();
  for (const event of recentAll) {
    if (event.proposalKey?.trim()) {
      recentSessionKeys.add(event.sessionKey);
    }
  }
  const sessionKeys = listWorkshopDashboardChangeFeedSessions(ctx.cfg, recentSessionKeys);
  const perSessionLimit = Math.min(200, Math.max(limit, Math.ceil(limit / sessionKeys.length) + 5));
  const seen = new Set<string>();
  const merged: ChangeEvent[] = [];
  for (const sessionKey of sessionKeys) {
    for (const event of ctx.changeFeed.listRecent({
      sessionKey,
      limit: perSessionLimit,
      status: "active",
    })) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      merged.push(event);
    }
  }
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged
    .filter((event) => event.action === "proposed" || event.action === "applied" || event.action === "detected")
    .slice(0, limit);
}

export function revertWorkshopChange(ctx: WorkshopDashboardContext, eventId: string) {
  if (!ctx.changeFeed) return { ok: false as const, error: "change feed unavailable" };
  const trimmed = eventId.trim();
  if (!trimmed) return { ok: false as const, error: "missing change event id" };
  const revertCtx = buildChangeRevertContext({
    changeFeed: ctx.changeFeed,
    cfg: ctx.cfg,
    workshopCtx: wctx(ctx),
    sessionKey: resolveWorkshopSessionKey(ctx.cfg),
  });
  return revertChangeById(revertCtx, trimmed);
}

export function collectDreamCycleLog(ctx: WorkshopDashboardContext, limit = 5): Array<Record<string, unknown>> {
  const dir = ctx.dreamCycleLogDir;
  if (!dir || !existsSync(dir)) return [];
  try {
    const stageFiles: Array<{ runId: string; path: string; mtimeMs: number }> = [];

    const collectStageFiles = (runDir: string, runId: string) => {
      if (!existsSync(runDir)) return;
      for (const f of readdirSync(runDir)) {
        if (!f.startsWith("stage-") || !f.endsWith(".json")) continue;
        const path = join(runDir, f);
        try {
          const stat = statSync(path);
          stageFiles.push({ runId, path, mtimeMs: stat.mtimeMs });
        } catch {
          stageFiles.push({ runId, path, mtimeMs: 0 });
        }
      }
    };

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("run-")) {
        collectStageFiles(join(dir, entry.name), entry.name.slice("run-".length));
      } else if (entry.isFile() && entry.name.startsWith("stage-") && entry.name.endsWith(".json")) {
        const path = join(dir, entry.name);
        try {
          const stat = statSync(path);
          stageFiles.push({ runId: "", path, mtimeMs: stat.mtimeMs });
        } catch {
          stageFiles.push({ runId: "", path, mtimeMs: 0 });
        }
      }
    }

    stageFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const runs = new Map<string, Array<Record<string, unknown>>>();
    for (const { runId: dirRunId, path } of stageFiles) {
      try {
        const payload = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        const runId = dirRunId || String(payload.runId ?? "unknown");
        if (!runs.has(runId)) runs.set(runId, []);
        runs.get(runId)!.push(payload);
      } catch {
        // skip corrupt artifact
      }
    }

    return [...runs.entries()].slice(0, limit).map(([runId, stages]) => ({
      runId,
      stages: stages.sort((a, b) => Number(a.stageNumber ?? 0) - Number(b.stageNumber ?? 0)),
    }));
  } catch {
    return [];
  }
}

export function collectSkillTelemetry(ctx: WorkshopDashboardContext) {
  try {
    const report = ctx.factsDb.buildGeneratedSkillTelemetryReport?.({ limit: 50 });
    return report?.rows ?? [];
  } catch {
    return [];
  }
}
