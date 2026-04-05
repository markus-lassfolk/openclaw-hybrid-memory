import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { getEnv } from "../utils/env-manager.js";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import type { BootstrapPhaseConfig } from "../config.js";
import { orderByBootstrapPhase } from "../services/bootstrap-priority.js";
import { capturePluginError } from "../services/error-reporter.js";
import { registerApitapTools } from "../tools/apitap-tools.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerCrystallizationTools } from "../tools/crystallization-tools.js";
import { type DashboardRoutesContext, registerDashboardHttpRoutes } from "../tools/dashboard-routes.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { type PluginContext as GraphToolsContext, registerGraphTools } from "../tools/graph-tools.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { type MemoryToolsContext, registerMemoryTools } from "../tools/memory-tools.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { type PluginContext as PersonaToolsContext, registerPersonaTools } from "../tools/persona-tools.js";
import { type PublicApiRoutesContext, registerPublicApiRoutes } from "../tools/public-api-routes.js";
import { registerProvenanceTools } from "../tools/provenance-tools.js";
import { registerSelfExtensionTools } from "../tools/self-extension-tools.js";
import { type PluginContext as UtilityToolsContext, registerUtilityTools } from "../tools/utility-tools.js";
import { registerVerificationTools } from "../tools/verification-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import { registerGoalTools, type GoalToolsContext } from "../tools/goal-tools.js";
import { registerTaskHygieneTools, resolveActiveTaskPathForTools } from "../tools/task-hygiene-tools.js";

export type ToolsContext = MemoryPluginAPI;

type ToolInstaller = BootstrapPhaseConfig & {
  id: string;
  selectContext(context: ToolsContext, api: ClawdbotPluginApi): unknown;
  install(context: unknown, api: ClawdbotPluginApi): void;
};

type UtilityInstallerContext = {
  toolContext: UtilityToolsContext;
  runReflection: MemoryPluginAPI["runReflection"];
  runReflectionRules: MemoryPluginAPI["runReflectionRules"];
  runReflectionMeta: MemoryPluginAPI["runReflectionMeta"];
  walWrite: (operation: "store" | "update", data: Record<string, unknown>) => Promise<string>;
  walRemove: (id: string) => Promise<void>;
};

type ProvenanceInstallerContext = Pick<ToolsContext, "factsDb" | "eventLog" | "provenanceService" | "cfg">;
type CredentialInstallerContext = Pick<ToolsContext, "credentialsDb" | "cfg">;
type DocumentInstallerContext = Pick<
  ToolsContext,
  "factsDb" | "vectorDb" | "cfg" | "embeddings" | "pythonBridge" | "openai" | "provenanceService"
>;
type VerificationInstallerContext = Pick<ToolsContext, "factsDb" | "verificationStore" | "cfg">;
type IssueInstallerContext = Pick<ToolsContext, "issueStore" | "cfg">;
type WorkflowInstallerContext = Pick<ToolsContext, "workflowStore">;
type CrystallizationInstallerContext = Pick<ToolsContext, "crystallizationStore" | "workflowStore" | "cfg">;
type SelfExtensionInstallerContext = Pick<ToolsContext, "toolProposalStore" | "workflowStore" | "cfg">;
type ApitapInstallerContext = Pick<ToolsContext, "apitapStore" | "cfg">;

function defineToolInstaller<TSelectedContext>(
  installer: BootstrapPhaseConfig & {
    id: string;
    selectContext(context: ToolsContext, api: ClawdbotPluginApi): TSelectedContext;
    install(context: TSelectedContext, api: ClawdbotPluginApi): void;
  },
): ToolInstaller {
  return installer as ToolInstaller;
}

function selectMemoryCoreToolsContext(ctx: ToolsContext): MemoryToolsContext {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    embeddingRegistry,
    openai,
    wal,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    verificationStore,
    variantQueue,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    buildToolScopeFilter,
    findSimilarByEmbedding,
    walWrite,
    walRemove,
    auditStore,
  } = ctx;

  return {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    embeddingRegistry,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    verificationStore,
    variantQueue,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    buildToolScopeFilter,
    walWrite: (operation, data, logger, supersedeTargetId) => walWrite(wal, operation, data, logger, supersedeTargetId),
    walRemove: (id, logger) => walRemove(wal, id, logger),
    findSimilarByEmbedding,
    auditStore,
  };
}

function installMemoryCoreTools(ctx: MemoryToolsContext, api: ClawdbotPluginApi): void {
  registerMemoryTools(ctx, api);
}

function selectGraphToolsContext({ factsDb, cfg }: ToolsContext): GraphToolsContext {
  return { factsDb, cfg };
}

function installGraphTools({ factsDb, cfg }: GraphToolsContext, api: ClawdbotPluginApi): void {
  if (cfg.graph.enabled) {
    registerGraphTools({ factsDb, cfg }, api);
  }
}

function selectUtilityToolsContext(ctx: ToolsContext, api: ClawdbotPluginApi): UtilityInstallerContext {
  const { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath, provenanceService } = ctx;
  return {
    toolContext: { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath, provenanceService },
    runReflection: ctx.runReflection,
    runReflectionRules: ctx.runReflectionRules,
    runReflectionMeta: ctx.runReflectionMeta,
    walWrite: (operation, data) => ctx.walWrite(wal, operation, data, api.logger),
    walRemove: (id) => ctx.walRemove(wal, id, api.logger),
  };
}

function installUtilityTools(ctx: UtilityInstallerContext, api: ClawdbotPluginApi): void {
  registerUtilityTools(
    ctx.toolContext,
    api,
    ctx.runReflection,
    ctx.runReflectionRules,
    ctx.runReflectionMeta,
    ctx.walWrite,
    ctx.walRemove,
  );
}

function selectProvenanceToolsContext({
  factsDb,
  eventLog,
  provenanceService,
  cfg,
}: ToolsContext): ProvenanceInstallerContext {
  return { factsDb, eventLog, provenanceService, cfg };
}

function installProvenanceTools(ctx: ProvenanceInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, eventLog, provenanceService, cfg } = ctx;
  if (cfg.provenance.enabled && provenanceService) {
    registerProvenanceTools({ factsDb, eventLog, provenanceService, cfg }, api);
  }
}

function selectCredentialToolsContext({ credentialsDb, cfg }: ToolsContext): CredentialInstallerContext {
  return { credentialsDb, cfg };
}

function installCredentialTools(ctx: CredentialInstallerContext, api: ClawdbotPluginApi): void {
  const { credentialsDb, cfg } = ctx;
  if (cfg.credentials.enabled && credentialsDb) {
    registerCredentialTools({ credentialsDb, cfg, api }, api);
  }
}

type PersonaInstallerContext = PersonaToolsContext & Pick<ToolsContext, "timers">;

function selectPersonaToolsContext({
  proposalsDb,
  cfg,
  resolvedSqlitePath,
  timers,
}: ToolsContext): PersonaInstallerContext {
  return { proposalsDb: proposalsDb ?? undefined, cfg, resolvedSqlitePath, timers };
}

function installPersonaTools(ctx: PersonaInstallerContext, api: ClawdbotPluginApi): void {
  const { proposalsDb, cfg, resolvedSqlitePath, timers } = ctx;
  if (!(cfg.personaProposals.enabled && proposalsDb)) return;

  registerPersonaTools({ proposalsDb, cfg, resolvedSqlitePath }, api);
  timers.proposalsPruneTimer.value = setInterval(
    () => {
      try {
        if (proposalsDb?.isOpen()) {
          const pruned = proposalsDb.pruneExpired();
          if (pruned > 0) {
            api.logger.info(`memory-hybrid: pruned ${pruned} expired proposal(s)`);
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "proposals",
          operation: "periodic-prune",
        });
        api.logger.warn(`memory-hybrid: proposal prune failed: ${err}`);
      }
    },
    24 * 60 * 60_000,
  );
}

function selectDocumentToolsContext({
  factsDb,
  vectorDb,
  cfg,
  embeddings,
  pythonBridge,
  openai,
  provenanceService,
}: ToolsContext): DocumentInstallerContext {
  return { factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService };
}

function installDocumentTools(ctx: DocumentInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService } = ctx;
  if (cfg.documents.enabled && pythonBridge) {
    registerDocumentTools({ factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService }, api);
  }
}

function selectVerificationToolsContext({
  factsDb,
  verificationStore,
  cfg,
}: ToolsContext): VerificationInstallerContext {
  return { factsDb, verificationStore, cfg };
}

function installVerificationTools(ctx: VerificationInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, verificationStore, cfg } = ctx;
  if (cfg.verification.enabled && verificationStore) {
    registerVerificationTools({ factsDb, verificationStore }, api);
  }
}

function selectIssueToolsContext({ issueStore, cfg }: ToolsContext): IssueInstallerContext {
  return { issueStore, cfg };
}

function installIssueTools(ctx: IssueInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.issueStore) {
    registerIssueTools({ issueStore: ctx.issueStore, cfg: ctx.cfg }, api);
  }
}

function selectWorkflowToolsContext({ workflowStore }: ToolsContext): WorkflowInstallerContext {
  return { workflowStore };
}

function installWorkflowTools(ctx: WorkflowInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.workflowStore) {
    registerWorkflowTools({ workflowStore: ctx.workflowStore }, api);
  }
}

function selectCrystallizationToolsContext({
  crystallizationStore,
  workflowStore,
  cfg,
}: ToolsContext): CrystallizationInstallerContext {
  return { crystallizationStore, workflowStore, cfg };
}

function installCrystallizationTools(ctx: CrystallizationInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.crystallizationStore && ctx.workflowStore) {
    registerCrystallizationTools(
      { crystallizationStore: ctx.crystallizationStore, workflowStore: ctx.workflowStore, cfg: ctx.cfg },
      api,
    );
  }
}

function selectSelfExtensionToolsContext({
  toolProposalStore,
  workflowStore,
  cfg,
}: ToolsContext): SelfExtensionInstallerContext {
  return { toolProposalStore, workflowStore, cfg };
}

function installSelfExtensionTools(ctx: SelfExtensionInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.toolProposalStore && ctx.workflowStore) {
    registerSelfExtensionTools(
      { toolProposalStore: ctx.toolProposalStore, workflowStore: ctx.workflowStore, cfg: ctx.cfg },
      api,
    );
  }
}

function selectApitapToolsContext({ apitapStore, cfg }: ToolsContext): ApitapInstallerContext {
  return { apitapStore, cfg };
}

function installApitapTools(ctx: ApitapInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.apitapStore) {
    registerApitapTools({ apitapStore: ctx.apitapStore, cfg: ctx.cfg }, api);
  }
}

function selectDashboardRoutesContext({ cfg }: ToolsContext): DashboardRoutesContext {
  return { cfg };
}

function installDashboardRoutes({ cfg }: DashboardRoutesContext, api: ClawdbotPluginApi): void {
  registerDashboardHttpRoutes({ cfg }, api);
}

function selectPublicApiRoutesContext({ cfg, factsDb, narrativesDb }: ToolsContext): PublicApiRoutesContext {
  return { cfg, factsDb, narrativesDb };
}

function installPublicApiRoutes(ctx: PublicApiRoutesContext, api: ClawdbotPluginApi): void {
  registerPublicApiRoutes(ctx, api);
}

function selectGoalToolsContext(ctx: ToolsContext): GoalToolsContext {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? pathJoin(homedir(), ".openclaw", "workspace");
  const goalsDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
  const resolvedActiveTaskPath = resolveActiveTaskPathForTools(ctx.cfg, workspaceRoot);
  return {
    cfg: ctx.cfg,
    goalsDir,
    workspaceRoot,
    resolvedActiveTaskPath,
    factsDb: ctx.factsDb,
    eventLog: ctx.eventLog,
    memoryDir: pathJoin(workspaceRoot, "memory"),
  };
}

function installGoalTools(ctx: GoalToolsContext, api: ClawdbotPluginApi): void {
  registerGoalTools(ctx, api);
  registerTaskHygieneTools(
    {
      cfg: ctx.cfg,
      resolvedActiveTaskPath: ctx.resolvedActiveTaskPath,
      workspaceRoot: ctx.workspaceRoot,
    },
    api,
  );
}

export const toolInstallers = orderByBootstrapPhase<ToolInstaller>([
  defineToolInstaller({
    id: "memoryCore",
    bootstrapPhase: "core",
    selectContext: (ctx) => selectMemoryCoreToolsContext(ctx),
    install: installMemoryCoreTools,
  }),
  defineToolInstaller({
    id: "goalStewardship",
    bootstrapPhase: "core",
    selectContext: (ctx) => selectGoalToolsContext(ctx),
    install: installGoalTools,
  }),
  defineToolInstaller({
    id: "retrievalGraph",
    bootstrapPhase: "core",
    selectContext: (ctx) => selectGraphToolsContext(ctx),
    install: installGraphTools,
  }),
  defineToolInstaller({
    id: "memoryUtility",
    bootstrapPhase: "core",
    selectContext: (ctx, api) => selectUtilityToolsContext(ctx, api),
    install: installUtilityTools,
  }),
  defineToolInstaller({
    id: "provenance",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectProvenanceToolsContext(ctx),
    install: installProvenanceTools,
  }),
  defineToolInstaller({
    id: "credentials",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectCredentialToolsContext(ctx),
    install: installCredentialTools,
  }),
  defineToolInstaller({
    id: "persona",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectPersonaToolsContext(ctx),
    install: installPersonaTools,
  }),
  defineToolInstaller({
    id: "documents",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectDocumentToolsContext(ctx),
    install: installDocumentTools,
  }),
  defineToolInstaller({
    id: "verification",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectVerificationToolsContext(ctx),
    install: installVerificationTools,
  }),
  defineToolInstaller({
    id: "issues",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectIssueToolsContext(ctx),
    install: installIssueTools,
  }),
  defineToolInstaller({
    id: "workflow",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectWorkflowToolsContext(ctx),
    install: installWorkflowTools,
  }),
  defineToolInstaller({
    id: "crystallization",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectCrystallizationToolsContext(ctx),
    install: installCrystallizationTools,
  }),
  defineToolInstaller({
    id: "selfExtension",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectSelfExtensionToolsContext(ctx),
    install: installSelfExtensionTools,
  }),
  defineToolInstaller({
    id: "apitap",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectApitapToolsContext(ctx),
    install: installApitapTools,
  }),
  defineToolInstaller({
    id: "dashboard",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectDashboardRoutesContext(ctx),
    install: installDashboardRoutes,
  }),
  defineToolInstaller({
    id: "publicApi",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectPublicApiRoutesContext(ctx),
    install: installPublicApiRoutes,
  }),
]);
