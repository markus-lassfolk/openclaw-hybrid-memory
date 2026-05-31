import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { AgentHealthStore, agentHealthDbPathForMemorySqlite } from "../backends/agent-health-store.js";
import { AuditStore, auditDbPathForMemorySqlite } from "../backends/audit-store.js";
import { EventBus } from "../backends/event-bus.js";
import { LearningsDB } from "../backends/learnings-db.js";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import { type PluginRuntime, clearRuntimeTimers, createTimers } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import { hybridConfigSchema } from "../config/hybrid-schema.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { getMemoryTriggers } from "../services/auto-capture.js";
import { detectCategory as detectCategoryUtil, shouldCapture as shouldCaptureUtil } from "../services/capture-utils.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "../services/contextual-variants.js";
import { capturePluginError } from "../services/error-reporter.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../services/reflection.js";
import { PythonBridge } from "../services/python-bridge.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { resetStartupMemoryAttribution } from "../services/startup-memory-attribution.js";
import { walRemove, walWrite } from "../services/wal-helpers.js";
import { registerHybridMemCliMetadataOnly } from "./cli-context/metadata.js";
import { registerHybridMemCliHelpOnlyWithApi } from "./cli-context/register-help.js";
import { registerHybridMemCliWithApi } from "./cli-context/register-full.js";
import "./cli-context.js";
import { closeOldDatabases, createReusedDatabaseBootstrap, initializeDatabases } from "./bootstrap-databases.js";
import "./init-databases.js";
import { createPluginService } from "./plugin-service.js";
import {
  canReuseDatabasesOnReregister,
  databaseContextFromRuntime,
  recordReregisterDatabaseReuse,
  recordReregisterFullTeardown,
  recordReregisterRegistration,
  resolveReregisterPolicy,
} from "./reregister-policy.js";
import {
  applyGatewayEmbeddingInheritanceBeforeParse,
  shallowClonePluginConfigForGatewayMerge,
} from "./provider-router.js";
import { getHybridMemoryRegistrationState } from "./hybrid-memory-generation-state.js";
import {
  blockReloadTeardownBeforeOpen,
  drainOldBootstrap,
  drainOldRecall,
  schedulePluginTeardown,
} from "./hybrid-memory-reload-coordinator.js";
import { registerContextEngineBestEffort } from "./register-context-engine.js";
import { registerLifecycleHooks } from "./register-hooks.js";
import { registerTools } from "./register-tools.js";
import { PLUGIN_ID } from "../utils/constants.js";
import { isHybridMemHelpInvocation } from "../index-help.js";
import { wrapApiLoggerStderrForJsonCli, restoreStdoutAfterJsonCli } from "../utils/hybrid-mem-json-cli.js";
import {
  getCategoryDecisionRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getCategoryPreferenceRegex,
} from "../utils/language-keywords.js";
import { initPluginLogger } from "../utils/logger.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { versionInfo } from "../versionInfo.js";

/** Wrappers for extracted helper functions that need access to per-instance config via runtimeRef. */
function shouldCapture(text: string): boolean {
  return shouldCaptureUtil(text, runtimeRef.value?.cfg.captureMaxChars ?? 5000, getMemoryTriggers());
}

function detectCategory(text: string): MemoryCategory {
  return detectCategoryUtil(
    text,
    getCategoryDecisionRegex(),
    getCategoryPreferenceRegex(),
    getCategoryEntityRegex(),
    getCategoryFactRegex(),
  );
}

const runtimeRef: { value: PluginRuntime | null } = { value: null };
const registrationGenerationRef = getHybridMemoryRegistrationState().registrationGenerationRef;

/** Guard to prevent concurrent registrations from interleaving (Issue #802 re-entrancy). */
let registrationInProgress = false;

/** Shared buffer for registration gate wait/notify (separate from reload coordinator buffer). */
const registrationGateWaitBuffer = new SharedArrayBuffer(4);
const registrationGateWaitArray = new Int32Array(registrationGateWaitBuffer);

/** Release DBs and timers after a `hybrid-mem` CLI command so the Node process can exit (Issue #1039). */
async function performHybridMemCliTeardown(): Promise<void> {
  // Restore stdout before checking runtime ref, so teardown without runtime still cleans up (issue #1618).
  restoreStdoutAfterJsonCli();

  const r = runtimeRef.value;
  if (!r) return;
  // Stop long-lived service timers first so one-shot CLI commands can exit promptly.
  clearRuntimeTimers(r.timers);
  try {
    await r.bootstrapAsyncInit;
  } catch {
    /* embedding/vault init may fail; still close handles */
  }
  // Startup can race with command completion; clear again after async init settles.
  clearRuntimeTimers(r.timers);
  try {
    r.lifecycleHooksHandle?.dispose();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "hybrid-mem-teardown:dispose-hooks",
    });
  }
  try {
    r.toolRegistrationHandle?.dispose();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "hybrid-mem-teardown:dispose-tools",
    });
  }
  try {
    closeOldDatabases({
      factsDb: r.factsDb,
      edictStore: r.edictStore,
      narrativesDb: r.narrativesDb,
      vectorDb: r.vectorDb,
      credentialsDb: r.credentialsDb,
      proposalsDb: r.proposalsDb,
      identityReflectionStore: r.identityReflectionStore,
      personaStateStore: r.personaStateStore,
      eventLog: r.eventLog,
      aliasDb: r.aliasDb,
      eventBus: r.eventBus,
      issueStore: r.issueStore,
      workflowStore: r.workflowStore,
      crystallizationStore: r.crystallizationStore,
      toolProposalStore: r.toolProposalStore,
      verificationStore: r.verificationStore,
      provenanceService: r.provenanceService,
      learningsDb: r.learningsDb,
      apitapStore: r.apitapStore,
      auditStore: r.auditStore,
      agentHealthStore: r.agentHealthStore,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "hybrid-mem-teardown:close-databases",
    });
  }
  try {
    await r.pythonBridge?.shutdown();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "hybrid-mem-teardown:python-bridge",
    });
  }
}

export function runMemoryHybridRegister(api: ClawdbotPluginApi): void {
  // OpenClaw `loadOpenClawPluginCliRegistry` — metadata only; no DBs or native deps (issue #1111).
  // Check this FIRST, before any logger init or config parsing, so an incomplete config
  // cannot block lightweight metadata registration.
  //
  // Issue #1209/#XXXX: Always register CLI metadata even when service markers are present in the environment.
  // Service markers (OPENCLAW_SERVICE_KIND, OPENCLAW_SERVICE_MARKER) should only prevent full plugin
  // initialization (databases, timers), not CLI metadata registration. Without this, `openclaw hybrid-mem`
  // commands become unavailable in cron/service environments where these markers leak.
  if (api.registrationMode === "cli-metadata") {
    registerHybridMemCliMetadataOnly(api);
    return;
  }

  // Help invocations should be cheap and deterministic: register the command tree but do not
  // bootstrap DBs or start background checks/timers that can keep Node alive after help prints.
  // Examples: `openclaw hybrid-mem --help`, `openclaw hybrid-mem verify --help`.
  if (isHybridMemHelpInvocation(process.argv)) {
    registerHybridMemCliHelpOnlyWithApi(api);
    return;
  }

  // Issue #802 re-entrancy: serialize concurrent register() calls. OpenClaw requires register()
  // to be synchronous (no Promise return), so we block with Atomics.wait instead of async/await.
  while (registrationInProgress) {
    Atomics.wait(registrationGateWaitArray, 0, 0, 50);
  }
  registrationInProgress = true;
  try {
    runMemoryHybridRegisterImpl(api);
  } finally {
    registrationInProgress = false;
    Atomics.notify(registrationGateWaitArray, 0, 1);
  }
}

function runMemoryHybridRegisterImpl(api: ClawdbotPluginApi): void {
  // Issue #1230 / #1234: JSON CLI must not write plugin telemetry to stdout (cron harnesses, jq).
  // Wrap api.logger to stderr before bootstrap; keep pluginLogger on that same logger delegate.
  const logApi = wrapApiLoggerStderrForJsonCli(api);
  initPluginLogger(logApi.logger, false);

  // Reopen guard: ensure any previous instance is closed before creating new one (avoids duplicate
  // DB instances if host calls register() before stop(), e.g. on SIGUSR1 or rapid reload).
  const old = runtimeRef.value;

  let cfg: HybridMemoryConfig;
  try {
    const rawPc = api.pluginConfig;
    const toParse =
      rawPc && typeof rawPc === "object" && !Array.isArray(rawPc)
        ? (() => {
            const clone = shallowClonePluginConfigForGatewayMerge(rawPc as Record<string, unknown>);
            applyGatewayEmbeddingInheritanceBeforeParse(clone, api);
            return clone;
          })()
        : rawPc;
    cfg = hybridConfigSchema.parse(toParse);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:config-parse",
    });
    throw err;
  }

  const registrationGeneration = registrationGenerationRef.value + 1;
  registrationGenerationRef.value = registrationGeneration;
  recordReregisterRegistration();

  const reusePolicy = resolveReregisterPolicy();
  const reuseDatabases = canReuseDatabasesOnReregister(old, cfg, logApi);
  if (old && reusePolicy === "reuse-databases" && !reuseDatabases) {
    logApi.logger.debug?.(
      "memory-hybrid: re-register falling back to full teardown (reuse policy requested but donor bootstrap not reusable)",
    );
  }
  const donorRuntime = reuseDatabases && old ? old : null;

  if (old) {
    // Clear old timer handles to prevent leaks.
    clearRuntimeTimers(old.timers);
    // Issue #463: Dispose lifecycle hooks (stale session sweep timer, per-session state)
    old.lifecycleHooksHandle?.dispose();
    // Issue #1630: Reset startup memory attribution so the new plugin generation can record fresh checkpoints.
    resetStartupMemoryAttribution();
    // Dispose tool registrations when API exposes unregister/dispose handles.
    old.toolRegistrationHandle?.dispose();
    if (reuseDatabases) {
      recordReregisterDatabaseReuse();
      logApi.logger.debug?.(
        `memory-hybrid: re-register reusing database handles (policy=${resolveReregisterPolicy()})`,
      );
    } else {
      recordReregisterFullTeardown();
      const oldRuntime = old;
      old.pythonBridge?.shutdown().catch(() => {});
      // Let in-flight bootstrap (vault check, embedding verify) finish before permanentClose (#1550 reload race).
      schedulePluginTeardown(async () => {
        await drainOldBootstrap(oldRuntime.bootstrapAsyncInit);
        await drainOldRecall(oldRuntime.recallInFlightRef);
        closeOldDatabases({
          factsDb: oldRuntime.factsDb,
          edictStore: oldRuntime.edictStore,
          vectorDb: oldRuntime.vectorDb,
          credentialsDb: oldRuntime.credentialsDb,
          proposalsDb: oldRuntime.proposalsDb,
          identityReflectionStore: oldRuntime.identityReflectionStore,
          personaStateStore: oldRuntime.personaStateStore,
          eventLog: oldRuntime.eventLog,
          narrativesDb: oldRuntime.narrativesDb,
          aliasDb: oldRuntime.aliasDb,
          eventBus: oldRuntime.eventBus,
          issueStore: oldRuntime.issueStore,
          workflowStore: oldRuntime.workflowStore,
          crystallizationStore: oldRuntime.crystallizationStore,
          toolProposalStore: oldRuntime.toolProposalStore,
          verificationStore: oldRuntime.verificationStore,
          provenanceService: oldRuntime.provenanceService,
          learningsDb: oldRuntime.learningsDb,
          apitapStore: oldRuntime.apitapStore,
          auditStore: oldRuntime.auditStore,
          agentHealthStore: oldRuntime.agentHealthStore,
        });
      });
    }
    runtimeRef.value = null;
  }

  if (old && !reuseDatabases) {
    // Wait for teardown to complete before opening new DB handles (#802).
    // Do NOT timeout — proceed only after prior generation fully closes to prevent double-opens.
    const drained = blockReloadTeardownBeforeOpen(0);
    if (!drained) {
      throw new Error("memory-hybrid: reload teardown did not drain before opening new databases");
    }
  }

  let dbContext: ReturnType<typeof initializeDatabases>;
  try {
    if (donorRuntime) {
      const health = { embeddingsOk: false, credentialsVaultOk: false, lastCheckTime: Date.now() };
      const newBootstrapPromise = createReusedDatabaseBootstrap(
        cfg,
        logApi,
        {
          embeddings: donorRuntime.embeddings,
          wal: donorRuntime.wal,
          credentialsDb: donorRuntime.credentialsDb,
          factsDb: donorRuntime.factsDb,
          vectorDb: donorRuntime.vectorDb,
          aliasDb: donorRuntime.aliasDb,
          resolvedSqlitePath: donorRuntime.resolvedSqlitePath,
          health,
        },
        { bootRegistrationGeneration: registrationGeneration },
      );
      dbContext = databaseContextFromRuntime(donorRuntime, { newBootstrapPromise, health });
    } else {
      dbContext = initializeDatabases(cfg, logApi, { bootRegistrationGeneration: registrationGeneration });
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:init-databases",
    });
    throw err;
  }

  const { resolvedSqlitePath, resolvedLancePath } = dbContext;

  logApi.logger.info(
    `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
  );

  // ========================================================================
  // Event Bus for Sensor Sweep (Issue #236)
  // ========================================================================

  let eventBus: EventBus | null = donorRuntime?.eventBus ?? null;
  if (cfg.sensorSweep.enabled && !eventBus) {
    try {
      const eventBusPath = join(dirname(resolvedSqlitePath), "event-bus.db");
      eventBus = new EventBus(eventBusPath);
      logApi.logger.info(`memory-hybrid: event bus initialized at ${eventBusPath}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:event-bus-init",
        severity: "warning",
      });
      eventBus = null;
    }
  }

  // ========================================================================
  // Python Bridge (lazy -- only when documents.enabled, spawns on first use)
  // ========================================================================

  // Initialized lazily -- PythonBridge only spawns the subprocess on first convert() call.
  // Dependency check runs from plugin service start() so `register()` stays lighter (issue #1111).
  const pythonBridge =
    donorRuntime?.pythonBridge ?? (cfg.documents.enabled ? new PythonBridge(cfg.documents.pythonPath) : null);

  // ========================================================================
  // Contextual Variant Generator (Issue #159)
  // ========================================================================

  let variantQueue: VariantGenerationQueue | null = null;
  if (cfg.contextualVariants.enabled) {
    const variantGenerator = new ContextualVariantGenerator(cfg.contextualVariants, dbContext.openai);
    variantQueue = new VariantGenerationQueue(variantGenerator, async (factId, variantType, variants) => {
      for (const v of variants) {
        dbContext.factsDb.storeVariant(factId, variantType, v);
      }
    });
  }

  // ========================================================================
  // Learnings Intake Buffer (Issue #617)
  // ========================================================================

  let learningsDb: LearningsDB | null = donorRuntime?.learningsDb ?? null;
  if (!learningsDb)
    try {
      const learningsDbPath = join(dirname(resolvedSqlitePath), "learnings.db");
      learningsDb = new LearningsDB(learningsDbPath);
      logApi.logger.info(`memory-hybrid: learnings DB initialized at ${learningsDbPath}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:learnings-db-init",
        severity: "warning",
      });
      learningsDb = null;
    }

  // ========================================================================
  // Audit log (Issue #790)
  // ========================================================================

  let auditStore: AuditStore | null = donorRuntime?.auditStore ?? null;
  if (!auditStore)
    try {
      const auditPath = auditDbPathForMemorySqlite(resolvedSqlitePath);
      if (auditPath) {
        auditStore = new AuditStore(auditPath);
        logApi.logger.info(`memory-hybrid: audit store initialized at ${auditPath}`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:audit-store-init",
        severity: "warning",
      });
      auditStore = null;
    }

  let agentHealthStore: AgentHealthStore | null = donorRuntime?.agentHealthStore ?? null;
  if (!agentHealthStore)
    try {
      const ahPath = agentHealthDbPathForMemorySqlite(resolvedSqlitePath);
      if (ahPath) {
        agentHealthStore = new AgentHealthStore(ahPath);
        logApi.logger.info(`memory-hybrid: agent health store initialized at ${ahPath}`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:agent-health-store-init",
        severity: "warning",
      });
      agentHealthStore = null;
    }

  // ========================================================================
  // Build PluginRuntime -- single instance-scoped container for all state
  // ========================================================================

  const bootstrapSettledRef = { value: false };
  const bootstrapAsyncInit = dbContext.initialized.finally(() => {
    bootstrapSettledRef.value = true;
  });

  const newRuntime: PluginRuntime = {
    cfg,
    resolvedLancePath,
    resolvedSqlitePath,
    factsDb: dbContext.factsDb,
    edictStore: dbContext.edictStore,
    vectorDb: dbContext.vectorDb,
    embeddings: dbContext.embeddings,
    embeddingRegistry: dbContext.embeddingRegistry,
    openai: dbContext.openai,
    credentialsDb: dbContext.credentialsDb,
    wal: dbContext.wal,
    proposalsDb: dbContext.proposalsDb,
    identityReflectionStore: dbContext.identityReflectionStore,
    personaStateStore: dbContext.personaStateStore,
    eventLog: dbContext.eventLog,
    narrativesDb: dbContext.narrativesDb,
    aliasDb: dbContext.aliasDb,
    eventBus,
    costTracker: dbContext.costTracker,
    issueStore: dbContext.issueStore,
    workflowStore: dbContext.workflowStore,
    crystallizationStore: dbContext.crystallizationStore,
    toolProposalStore: dbContext.toolProposalStore,
    provenanceService: dbContext.provenanceService,
    verificationStore: dbContext.verificationStore,
    apitapStore: dbContext.apitapStore,
    pythonBridge,
    variantQueue,
    learningsDb,
    auditStore,
    agentHealthStore,
    lifecycleHooksHandle: null, // set after registerLifecycleHooks below
    toolRegistrationHandle: null, // set after registerTools below
    bootstrapAsyncInit,
    bootstrapSettledRef,
    bootstrapHealth: dbContext.health,
    pendingLLMWarnings: createPendingLLMWarnings(),
    currentAgentIdRef: { value: null },
    restartPendingClearedRef: { value: false },
    recallInFlightRef: { value: 0 },
    lastAutoRecallPromptRef: { value: null },
    lastProgressiveIndexIds: [],
    timers: createTimers(),
  };

  runtimeRef.value = newRuntime;

  const runtime = newRuntime;

  // Phase 2.6 / Phase 3: Single plugin context satisfying MemoryPluginAPI (stable internal API).
  const pluginContext: MemoryPluginAPI = {
    factsDb: runtime.factsDb,
    edictStore: runtime.edictStore,
    vectorDb: runtime.vectorDb,
    cfg: runtime.cfg,
    embeddings: runtime.embeddings,
    embeddingRegistry: runtime.embeddingRegistry,
    openai: runtime.openai,
    wal: runtime.wal,
    credentialsDb: runtime.credentialsDb,
    aliasDb: runtime.aliasDb,
    proposalsDb: runtime.proposalsDb,
    eventLog: runtime.eventLog,
    narrativesDb: runtime.narrativesDb,
    provenanceService: runtime.provenanceService,
    issueStore: runtime.issueStore ?? null,
    workflowStore: runtime.workflowStore,
    crystallizationStore: runtime.crystallizationStore,
    toolProposalStore: runtime.toolProposalStore,
    verificationStore: runtime.verificationStore,
    variantQueue: runtime.variantQueue,
    lastProgressiveIndexIds: runtime.lastProgressiveIndexIds,
    currentAgentIdRef: runtime.currentAgentIdRef,
    restartPendingClearedRef: runtime.restartPendingClearedRef,
    recallInFlightRef: runtime.recallInFlightRef,
    lastAutoRecallPromptRef: runtime.lastAutoRecallPromptRef,
    registrationGeneration,
    currentRegistrationGenerationRef: registrationGenerationRef,
    pendingLLMWarnings: runtime.pendingLLMWarnings,
    resolvedSqlitePath: runtime.resolvedSqlitePath,
    timers: { proposalsPruneTimer: runtime.timers.proposalsPruneTimer },
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    shouldCapture,
    detectCategory,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    pythonBridge: runtime.pythonBridge,
    apitapStore: runtime.apitapStore,
    auditStore: runtime.auditStore,
    agentHealthStore: runtime.agentHealthStore,
  };

  // ========================================================================
  // Tools

  try {
    runtime.toolRegistrationHandle = registerTools(pluginContext, logApi);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:tools",
    });
    throw err;
  }

  // CLI Commands — after a hybrid-mem subcommand finishes, tear down DBs and timers so the
  // one-shot `openclaw hybrid-mem …` process can exit (Issue #1039; persistent LanceDB + sweep timer).
  try {
    registerHybridMemCliWithApi(
      logApi,
      {
        factsDb: runtime.factsDb,
        vectorDb: runtime.vectorDb,
        embeddings: runtime.embeddings,
        openai: runtime.openai,
        cfg: runtime.cfg,
        credentialsDb: runtime.credentialsDb,
        aliasDb: runtime.aliasDb,
        wal: runtime.wal,
        proposalsDb: runtime.proposalsDb,
        identityReflectionStore: runtime.identityReflectionStore,
        personaStateStore: runtime.personaStateStore,
        crystallizationStore: runtime.crystallizationStore ?? null,
        eventLog: runtime.eventLog,
        verificationStore: runtime.verificationStore,
        provenanceService: runtime.provenanceService,
        costTracker: runtime.costTracker,
        eventBus: runtime.eventBus,
        resolvedSqlitePath: runtime.resolvedSqlitePath,
        resolvedLancePath: runtime.resolvedLancePath,
        pluginId: PLUGIN_ID,
        detectCategory,
        auditStore: runtime.auditStore,
        agentHealthStore: runtime.agentHealthStore ?? null,
      },
      { onHybridMemCliComplete: () => performHybridMemCliTeardown() },
    );
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:cli",
    });
    throw err;
  }

  // ContextEngine Plugin Slot (Issue #273) -- feature-detected, non-fatal if unavailable

  registerContextEngineBestEffort({
    runtime,
    logger: logApi.logger,
    pluginVersion: versionInfo.pluginVersion,
  });

  // Lifecycle Hooks (issueStore may be null; issue-related behavior is gated inside hooks)
  try {
    runtime.lifecycleHooksHandle = registerLifecycleHooks(pluginContext, logApi);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:hooks",
    });
    throw err;
  }

  // Service

  try {
    api.registerService(
      createPluginService({
        PLUGIN_ID,
        factsDb: runtime.factsDb,
        edictStore: runtime.edictStore,
        vectorDb: runtime.vectorDb,
        embeddings: runtime.embeddings,
        embeddingRegistry: runtime.embeddingRegistry,
        credentialsDb: runtime.credentialsDb,
        proposalsDb: runtime.proposalsDb,
        wal: runtime.wal,
        eventLog: runtime.eventLog,
        cfg: runtime.cfg,
        openai: runtime.openai,
        resolvedLancePath: runtime.resolvedLancePath,
        resolvedSqlitePath: runtime.resolvedSqlitePath,
        api: logApi,
        timers: runtime.timers,
        pythonBridge: runtime.pythonBridge,
        provenanceService: runtime.provenanceService,
        costTracker: runtime.costTracker,
        auditStore: runtime.auditStore ?? null,
        agentHealthStore: runtime.agentHealthStore ?? null,
      }),
    );
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:service",
    });
    throw err;
  }

  // Issue #281 -- Verify cron health on boot
  //
  // When `maintenance.cronReliability.verifyOnBoot` is true (the default), check
  // whether a backup cron entry exists and log a warning if missing. This does NOT
  // auto-install the cron entry -- users must explicitly run `hybrid-mem backup schedule`
  // to install it.
  //
  // This runs asynchronously and is entirely non-fatal: cron check failures
  // (e.g. no `crontab` binary, read-only environment) are logged as debug and do not
  // block the plugin from starting.
  if (cfg.maintenance?.cronReliability?.verifyOnBoot !== false) {
    setImmediate(() => {
      void (async () => {
        try {
          const { execSync } = await import("node:child_process");

          // Check if a backup cron is already registered
          let currentCrontab = "";
          try {
            currentCrontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
          } catch {
            // No existing crontab
          }

          if (currentCrontab.includes("hybrid-mem backup")) {
            // Already scheduled -- nothing to do
            logApi.logger.debug?.("memory-hybrid: boot-check -- weekly backup cron already present");
            return;
          }

          // Cron not found -- log warning
          const weeklyExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
          logApi.logger.warn?.(
            `memory-hybrid: boot-check -- weekly backup cron not found. Run 'hybrid-mem backup schedule' to install (${weeklyExpr}).`,
          );
        } catch (err) {
          // Non-fatal -- crontab may not be available (containers, read-only envs)
          logApi.logger.debug?.(`memory-hybrid: boot-check -- could not verify backup cron (non-fatal): ${err}`);
        }
      })();
    });
  }
}

export { runtimeRef, shouldCapture, detectCategory, performHybridMemCliTeardown };
