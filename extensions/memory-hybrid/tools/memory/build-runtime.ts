import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { TASK_LEDGER_CATEGORY, activeTaskRenderGoalsOpts, refreshActiveTaskProjectionBestEffort } from "../../services/task-ledger-facts.js";
import { storeCanonicalVectorForFact } from "../../services/vector-maintenance.js";
import { parseDuration } from "../../utils/duration.js";
import { getEnv } from "../../utils/env-manager.js";
import { resolveWorkspacePath } from "../../utils/path.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryToolsContext } from "./types.js";
import type { MemoryToolRuntime } from "./runtime.js";
import { isEdictWriteToolEnabled, sanitizeScopeParam, storeRegistryEmbeddings } from "./helpers.js";

export function buildMemoryToolRuntime(resolvedContext: MemoryToolsContext, api: ClawdbotPluginApi): MemoryToolRuntime {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    embeddingRegistry,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    variantQueue,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    auditStore,
  } = resolvedContext;

  const agentIdForAudit = () => currentAgentIdRef.value || cfg.multiAgent.orchestratorId || "unknown";

  function auditAppend(input: import("../../backends/audit-store.js").AuditEventInput): void {
    if (!auditStore) return;
    try {
      auditStore.append(input);
    } catch {
      /* non-fatal */
    }
  }

  const activeTaskCfg = cfg.activeTask;
  const activeTaskProjectionPath = activeTaskCfg ? resolveWorkspacePath(activeTaskCfg.filePath) : null;
  const activeTaskStaleMinutes = (() => {
    if (!activeTaskCfg) return parseDuration("24h");
    try {
      return parseDuration(activeTaskCfg.staleThreshold);
    } catch {
      return parseDuration("24h");
    }
  })();
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");

  const maybeRefreshProjectActiveTaskProjection = async (
    factCategory: string,
    factId: string,
    factScope: string | null | undefined,
  ): Promise<void> => {
    if (!activeTaskCfg?.enabled || activeTaskCfg.ledger !== "facts" || !activeTaskProjectionPath) return;
    if (factCategory !== TASK_LEDGER_CATEGORY) return;
    if ((factScope ?? "global") !== "global") return;
    await refreshActiveTaskProjectionBestEffort({
      factsDb,
      staleMinutes: activeTaskStaleMinutes,
      filePath: activeTaskProjectionPath,
      projection: activeTaskCfg.projection,
      reason: "memory_store_project_fact_write",
      source: "memory_store",
      factId,
      logger: api.logger,
      goalsDir: activeTaskRenderGoalsOpts(cfg, workspaceRoot).goalsDir,
    });
  };

  const storeActiveCanonicalVector = async (options: {
    factId: string;
    text: string;
    why?: string | null;
    vector: number[];
    importance: number;
    category: string;
  }): Promise<void> => {
    await storeCanonicalVectorForFact({
      vectorDb,
      factsDb,
      factId: options.factId,
      text: options.text,
      why: options.why,
      vector: options.vector,
      importance: options.importance,
      category: options.category,
      embeddingModel: embeddings.modelName,
    });
  };

  return {
    ...resolvedContext,
    api,
    auditAppend,
    agentIdForAudit,
    maybeRefreshProjectActiveTaskProjection,
    storeActiveCanonicalVector,
    storeRegistryEmbeddings,
    isEdictWriteToolEnabled,
    sanitizeScopeParam,
  };
}
