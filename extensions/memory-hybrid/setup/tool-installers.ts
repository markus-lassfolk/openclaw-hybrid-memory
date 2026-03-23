import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import type { BootstrapPhaseConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { orderByBootstrapPhase } from "../services/bootstrap-priority.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerCrystallizationTools } from "../tools/crystallization-tools.js";
import { registerDashboardHttpRoutes } from "../tools/dashboard-routes.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { registerGraphTools } from "../tools/graph-tools.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { registerPersonaTools } from "../tools/persona-tools.js";
import { registerProvenanceTools } from "../tools/provenance-tools.js";
import { registerSelfExtensionTools } from "../tools/self-extension-tools.js";
import { registerApitapTools } from "../tools/apitap-tools.js";
import { registerUtilityTools } from "../tools/utility-tools.js";
import { registerVerificationTools } from "../tools/verification-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";

export type ToolInstallerContext = MemoryPluginAPI;

export type ToolInstaller = BootstrapPhaseConfig & {
  id: string;
  install(context: ToolInstallerContext, api: ClawdbotPluginApi): void;
};

function installMemoryCoreTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const {
    factsDb,
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
    walWrite,
    walRemove,
    findSimilarByEmbedding,
  } = ctx;

  registerMemoryTools(
    {
      factsDb,
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
    },
    api,
    buildToolScopeFilter,
    (operation, data, logger) => walWrite(wal, operation, data, logger),
    (id, logger) => walRemove(wal, id, logger),
    findSimilarByEmbedding,
  );
}

function installGraphTools({ factsDb, cfg }: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (cfg.graph.enabled) {
    registerGraphTools({ factsDb, cfg }, api);
  }
}

function installUtilityTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath, provenanceService } = ctx;
  registerUtilityTools(
    { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath, provenanceService },
    api,
    ctx.runReflection,
    ctx.runReflectionRules,
    ctx.runReflectionMeta,
    (operation, data) => ctx.walWrite(wal, operation, data, api.logger),
    (id) => ctx.walRemove(wal, id, api.logger),
  );
}

function installProvenanceTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, eventLog, provenanceService, cfg } = ctx;
  if (cfg.provenance.enabled && provenanceService) {
    registerProvenanceTools({ factsDb, eventLog, provenanceService, cfg }, api);
  }
}

function installCredentialTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const { credentialsDb, cfg } = ctx;
  if (cfg.credentials.enabled && credentialsDb) {
    registerCredentialTools({ credentialsDb, cfg, api }, api);
  }
}

function installPersonaTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
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

function installDocumentTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService } = ctx;
  if (cfg.documents.enabled && pythonBridge) {
    registerDocumentTools({ factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService }, api);
  }
}

function installVerificationTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  const { factsDb, verificationStore, cfg } = ctx;
  if (cfg.verification.enabled && verificationStore) {
    registerVerificationTools({ factsDb, verificationStore }, api);
  }
}

function installIssueTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.issueStore) {
    registerIssueTools({ issueStore: ctx.issueStore, cfg: ctx.cfg }, api);
  }
}

function installWorkflowTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.workflowStore) {
    registerWorkflowTools({ workflowStore: ctx.workflowStore }, api);
  }
}

function installCrystallizationTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.crystallizationStore && ctx.workflowStore) {
    registerCrystallizationTools(
      { crystallizationStore: ctx.crystallizationStore, workflowStore: ctx.workflowStore, cfg: ctx.cfg },
      api,
    );
  }
}

function installSelfExtensionTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.toolProposalStore && ctx.workflowStore) {
    registerSelfExtensionTools(
      { toolProposalStore: ctx.toolProposalStore, workflowStore: ctx.workflowStore, cfg: ctx.cfg },
      api,
    );
  }
}

function installApitapTools(ctx: ToolInstallerContext, api: ClawdbotPluginApi): void {
  if (ctx.apitapStore) {
    registerApitapTools({ apitapStore: ctx.apitapStore, cfg: ctx.cfg }, api);
  }
}

function installDashboardRoutes({ cfg }: ToolInstallerContext, api: ClawdbotPluginApi): void {
  registerDashboardHttpRoutes({ cfg }, api);
}

export const toolInstallers = orderByBootstrapPhase<ToolInstaller>([
  { id: "memoryCore", bootstrapPhase: "core", install: installMemoryCoreTools },
  { id: "retrievalGraph", bootstrapPhase: "core", install: installGraphTools },
  { id: "memoryUtility", bootstrapPhase: "core", install: installUtilityTools },
  { id: "provenance", bootstrapPhase: "optional", install: installProvenanceTools },
  { id: "credentials", bootstrapPhase: "optional", install: installCredentialTools },
  { id: "persona", bootstrapPhase: "optional", install: installPersonaTools },
  { id: "documents", bootstrapPhase: "optional", install: installDocumentTools },
  { id: "verification", bootstrapPhase: "optional", install: installVerificationTools },
  { id: "issues", bootstrapPhase: "optional", install: installIssueTools },
  { id: "workflow", bootstrapPhase: "optional", install: installWorkflowTools },
  { id: "crystallization", bootstrapPhase: "optional", install: installCrystallizationTools },
  { id: "selfExtension", bootstrapPhase: "optional", install: installSelfExtensionTools },
  { id: "apitap", bootstrapPhase: "optional", install: installApitapTools },
  { id: "dashboard", bootstrapPhase: "optional", install: installDashboardRoutes },
]);
