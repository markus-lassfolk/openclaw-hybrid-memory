import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import type { BootstrapPhaseConfig } from "../config.js";
import { orderByBootstrapPhase } from "../services/bootstrap-priority.js";
import { capturePluginError } from "../services/error-reporter.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { registerApitapTools } from "../tools/apitap-tools.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerCrystallizationTools } from "../tools/crystallization-tools.js";
import { type DashboardRoutesContext, registerDashboardHttpRoutes } from "../tools/dashboard-routes.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { type GoalToolsContext, registerGoalTools } from "../tools/goal-tools.js";
import { registerHealthTools } from "../tools/health-dashboard.js";
import { type PluginContext as GraphToolsContext, registerGraphTools } from "../tools/graph-tools.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { type MemoryToolsContext, registerMemoryTools } from "../tools/memory-tools.js";
import { type PluginContext as PersonaToolsContext, registerPersonaTools } from "../tools/persona-tools.js";
import { registerProvenanceTools } from "../tools/provenance-tools.js";
import { type PublicApiRoutesContext, registerPublicApiRoutes } from "../tools/public-api-routes.js";
import { registerSelfExtensionTools } from "../tools/self-extension-tools.js";
import { registerTaskHygieneTools, resolveActiveTaskPathForTools } from "../tools/task-hygiene-tools.js";
import { type PluginContext as UtilityToolsContext, registerUtilityTools } from "../tools/utility-tools.js";
import { registerVerificationTools } from "../tools/verification-tools.js";
import { registerWorkshopTools, type WorkshopToolsContext } from "../tools/workshop-tool.js";
import { isWorkshopEnabled } from "../services/workshop-config.js";
import { registerProposalGatewayMethods, type ProposalGatewayContext } from "../tools/proposal-gateway-methods.js";
import { registerProposalHttpRoutes, type ProposalRoutesContext } from "../tools/proposal-routes.js";
import { registerFactMutationGatewayMethods, type FactMutationGatewayContext } from "../tools/fact-mutation-gateway.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import { getEnv } from "../utils/env-manager.js";

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
  walWrite: (operation: "store" | "update", data: Record<string, unknown>) => Promise<string | null>;
  walRemove: (id: string) => Promise<void>;
};

type ProvenanceInstallerContext = Pick<ToolsContext, "factsDb" | "eventLog" | "provenanceService" | "cfg">;
type CredentialInstallerContext = Pick<ToolsContext, "credentialsDb" | "factsDb" | "vectorDb" | "cfg">;
type DocumentInstallerContext = Pick<
  ToolsContext,
  "factsDb" | "vectorDb" | "cfg" | "embeddings" | "pythonBridge" | "openai" | "provenanceService"
>;
type VerificationInstallerContext = Pick<ToolsContext, "factsDb" | "verificationStore" | "cfg">;
type IssueInstallerContext = Pick<ToolsContext, "issueStore" | "factsDb" | "cfg">;
type WorkflowInstallerContext = Pick<ToolsContext, "workflowStore" | "cfg">;
type CrystallizationInstallerContext = Pick<
  ToolsContext,
  "crystallizationStore" | "workflowStore" | "factsDb" | "cfg" | "changeFeed"
>;
type SelfExtensionInstallerContext = Pick<ToolsContext, "toolProposalStore" | "workflowStore" | "cfg" | "changeFeed">;
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
    progressiveIndexBySession,
    lastAutoRecallPromptBySession,
    currentAgentIdRef,
    pendingLLMWarnings,
    buildToolScopeFilter,
    findSimilarByEmbedding,
    walWrite,
    walRemove,
    auditStore,
    issueStore,
    resolveVault,
    resolveAllVaults,
    resolveVaultWal,
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
    progressiveIndexBySession,
    lastAutoRecallPromptBySession,
    currentAgentIdRef,
    pendingLLMWarnings,
    buildToolScopeFilter,
    wal,
    walWrite: (operation, data, logger, supersedeTargetId) => walWrite(wal, operation, data, logger, supersedeTargetId),
    walRemove: (id, logger) => walRemove(wal, id, logger),
    findSimilarByEmbedding,
    auditStore,
    issueStore,
    resolveVault,
    resolveAllVaults,
    resolveVaultWal,
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

function selectCredentialToolsContext({
  credentialsDb,
  factsDb,
  vectorDb,
  cfg,
}: ToolsContext): CredentialInstallerContext {
  return { credentialsDb, factsDb, vectorDb, cfg };
}

function installCredentialTools(ctx: CredentialInstallerContext, api: ClawdbotPluginApi): void {
  const { credentialsDb, factsDb, vectorDb, cfg } = ctx;
  if (cfg.credentials.enabled && credentialsDb) {
    registerCredentialTools({ credentialsDb, factsDb, vectorDb, cfg, api }, api);
  }
}

type PersonaInstallerContext = PersonaToolsContext & Pick<ToolsContext, "timers">;

function selectPersonaToolsContext({
  proposalsDb,
  cfg,
  resolvedSqlitePath,
  changeFeed,
  factsDb,
  crystallizationStore,
  toolProposalStore,
  timers,
}: ToolsContext): PersonaInstallerContext {
  return {
    proposalsDb: proposalsDb ?? undefined,
    cfg,
    resolvedSqlitePath,
    changeFeed,
    factsDb,
    crystallizationStore,
    toolProposalStore,
    timers,
  };
}

function installPersonaTools(ctx: PersonaInstallerContext, api: ClawdbotPluginApi): void {
  const { proposalsDb, cfg, resolvedSqlitePath, changeFeed, factsDb, crystallizationStore, toolProposalStore, timers } =
    ctx;
  if (!(cfg.personaProposals.enabled && proposalsDb)) return;

  registerPersonaTools(
    { proposalsDb, cfg, resolvedSqlitePath, changeFeed, factsDb, crystallizationStore, toolProposalStore },
    api,
  );
  timers.proposalsPruneTimer.value = null; // proposals-prune handled by maintenance orchestrator cycle tick
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

function selectIssueToolsContext({ issueStore, factsDb, cfg }: ToolsContext): IssueInstallerContext {
  return { issueStore, factsDb, cfg };
}

function installIssueTools(ctx: IssueInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.issueStore) {
    registerIssueTools({ issueStore: ctx.issueStore, factsDb: ctx.factsDb, cfg: ctx.cfg }, api);
  }
}

function selectWorkflowToolsContext({ workflowStore, cfg }: ToolsContext): WorkflowInstallerContext {
  return { workflowStore, cfg };
}

function installWorkflowTools(ctx: WorkflowInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.workflowStore) {
    registerWorkflowTools(
      {
        workflowStore: ctx.workflowStore,
        excludeSystemGoals: ctx.cfg.crystallization?.excludeSystemGoals,
        excludeGoalPatterns: ctx.cfg.crystallization?.excludeGoalPatterns,
      },
      api,
    );
  }
}

function selectCrystallizationToolsContext({
  crystallizationStore,
  workflowStore,
  factsDb,
  cfg,
  changeFeed,
}: ToolsContext): CrystallizationInstallerContext {
  return { crystallizationStore, workflowStore, factsDb, cfg, changeFeed };
}

function installCrystallizationTools(ctx: CrystallizationInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.crystallizationStore && ctx.workflowStore) {
    registerCrystallizationTools(
      {
        crystallizationStore: ctx.crystallizationStore,
        workflowStore: ctx.workflowStore,
        factsDb: ctx.factsDb,
        cfg: ctx.cfg,
        changeFeed: ctx.changeFeed ?? null,
      },
      api,
    );
  }
}

function selectSelfExtensionToolsContext({
  toolProposalStore,
  workflowStore,
  cfg,
  changeFeed,
}: ToolsContext): SelfExtensionInstallerContext {
  return { toolProposalStore, workflowStore, cfg, changeFeed };
}

function installSelfExtensionTools(ctx: SelfExtensionInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.toolProposalStore && ctx.workflowStore) {
    registerSelfExtensionTools(
      {
        toolProposalStore: ctx.toolProposalStore,
        workflowStore: ctx.workflowStore,
        cfg: ctx.cfg,
        changeFeed: ctx.changeFeed ?? null,
      },
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

type HealthInstallerContext = Pick<ToolsContext, "factsDb" | "cfg" | "resolvedSqlitePath" | "vectorDb">;

function selectHealthToolsContext({
  factsDb,
  cfg,
  resolvedSqlitePath,
  vectorDb,
}: ToolsContext): HealthInstallerContext {
  return { factsDb, cfg, resolvedSqlitePath, vectorDb };
}

function installHealthTools(ctx: HealthInstallerContext, api: ClawdbotPluginApi): void {
  registerHealthTools(
    {
      factsDb: ctx.factsDb,
      cfg: ctx.cfg,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      resolvedLancePath: typeof ctx.vectorDb?.getPath === "function" ? ctx.vectorDb.getPath() : "",
    },
    api,
  );
}

function selectPublicApiRoutesContext({
  cfg,
  factsDb,
  narrativesDb,
  vectorDb,
  resolvedSqlitePath,
  recallInFlightRef,
  variantQueue,
}: ToolsContext): PublicApiRoutesContext {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? pathJoin(homedir(), ".openclaw", "workspace");
  const goalsDir =
    cfg.goalStewardship?.enabled === true ? resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir) : undefined;
  return {
    cfg,
    factsDb,
    narrativesDb,
    vectorDb,
    resolvedSqlitePath,
    resolvedLancePath: typeof vectorDb?.getPath === "function" ? vectorDb.getPath() : undefined,
    recallInFlightRef,
    variantQueue,
    goalsDir,
    factMutationsEnabled: cfg.wikiIntegration?.mutations?.enabled === true,
  };
}

function installPublicApiRoutes(ctx: PublicApiRoutesContext, api: ClawdbotPluginApi): void {
  registerPublicApiRoutes(ctx, api);
}

function selectWorkshopToolsContext({
  cfg,
  factsDb,
  proposalsDb,
  crystallizationStore,
  toolProposalStore,
  workflowStore,
  resolvedSqlitePath,
  changeFeed,
  sessionStateRef,
}: ToolsContext): WorkshopToolsContext {
  return {
    cfg,
    factsDb,
    proposalsDb,
    crystallizationStore,
    toolProposalStore,
    workflowStore,
    resolvedSqlitePath,
    changeFeed,
    sessionStateRef,
  };
}

function installWorkshopTools(ctx: WorkshopToolsContext, api: ClawdbotPluginApi): void {
  if (!isWorkshopEnabled(ctx.cfg)) return;
  registerWorkshopTools(ctx, api);
}

function selectProposalRoutesContext(ctx: ToolsContext, api: ClawdbotPluginApi): ProposalRoutesContext {
  return {
    cfg: { health: ctx.cfg.health },
    cfgFull: ctx.cfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb,
    crystallizationStore: ctx.crystallizationStore,
    toolProposalStore: ctx.toolProposalStore,
    workflowStore: ctx.workflowStore,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    changeFeed: ctx.changeFeed,
    sessionStateRef: ctx.sessionStateRef,
    api,
  };
}

function installProposalRoutes(ctx: ProposalRoutesContext): void {
  if (!isWorkshopEnabled(ctx.cfgFull)) return;
  registerProposalHttpRoutes(ctx);
  registerProposalGatewayMethods({ ...ctx, cfg: ctx.cfgFull });
}

function selectFactMutationGatewayContext(ctx: ToolsContext, api: ClawdbotPluginApi): FactMutationGatewayContext {
  return { cfg: ctx.cfg, factsDb: ctx.factsDb, api };
}

function installFactMutationGateway(ctx: FactMutationGatewayContext): void {
  registerFactMutationGatewayMethods(ctx);
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
    vectorDb: ctx.vectorDb,
    embeddings: ctx.embeddings,
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
      factsDb: ctx.factsDb,
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
    id: "workshop",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectWorkshopToolsContext(ctx),
    install: installWorkshopTools,
  }),
  defineToolInstaller({
    id: "proposalRoutes",
    bootstrapPhase: "optional",
    selectContext: (ctx, api) => selectProposalRoutesContext(ctx, api),
    install: installProposalRoutes,
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
    id: "health",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectHealthToolsContext(ctx),
    install: installHealthTools,
  }),
  defineToolInstaller({
    id: "publicApi",
    bootstrapPhase: "optional",
    selectContext: (ctx) => selectPublicApiRoutesContext(ctx),
    install: installPublicApiRoutes,
  }),
  defineToolInstaller({
    id: "factMutationGateway",
    bootstrapPhase: "optional",
    selectContext: (ctx, api) => selectFactMutationGatewayContext(ctx, api),
    install: installFactMutationGateway,
  }),
]);
