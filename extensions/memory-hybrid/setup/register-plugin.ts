import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import { clearRuntimeTimers, createTimers, type PluginRuntime } from "../api/plugin-runtime.js";
import { AgentHealthStore, agentHealthDbPathForMemorySqlite } from "../backends/agent-health-store.js";
import { AuditStore, auditDbPathForMemorySqlite } from "../backends/audit-store.js";
import { EventBus } from "../backends/event-bus.js";
import { LearningsDB } from "../backends/learnings-db.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import { getMemoryTriggers } from "../services/auto-capture.js";
import { detectCategory as detectCategoryUtil, shouldCapture as shouldCaptureUtil } from "../services/capture-utils.js";
import { ChangeFeed } from "../services/change-feed.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "../services/contextual-variants.js";
import { capturePluginError } from "../services/error-reporter.js";
import { warnGraphRecallConfigMisconfiguration } from "../services/graph-recall-config.js";
import { wirePostStoreEnrichment } from "../services/post-store-enrichment.js";
import { PythonBridge } from "../services/python-bridge.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../services/reflection.js";
import { resetStartupMemoryAttribution } from "../services/startup-memory-attribution.js";
import { createVaultRegistry } from "../services/vault-registry.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { walRemove, walWrite } from "../services/wal-helpers.js";
import { startEventLoopLagMonitor, stopEventLoopLagMonitor } from "../utils/event-loop-health.js";
import { registerHybridMemCliMetadataOnly } from "./cli-context/metadata.js";
import { registerHybridMemCliCredentialsOnlyWithApi } from "./cli-context/register-credentials-only.js";
import { registerHybridMemCliWithApi } from "./cli-context/register-full.js";
import { registerHybridMemCliHelpOnlyWithApi } from "./cli-context/register-help.js";
import { registerHybridMemCliUpgradeOnlyWithApi } from "./cli-context/register-upgrade-only.js";
import { registerHybridMemCliVersionOnlyWithApi } from "./cli-context/register-version-only.js";
import { parseHybridMemPluginConfig } from "./parse-plugin-config.js";
import "./cli-context.js";
import { closeOldDatabases, createReusedDatabaseBootstrap, initializeDatabases } from "./bootstrap-databases.js";
import "./init-databases.js";
import { isHybridMemCredentialsOnlyInvocation } from "../index-credentials-cli.js";
import { isHybridMemHelpInvocation } from "../index-help.js";
import { isHybridMemUpgradeOnlyInvocation } from "../index-upgrade-cli.js";
import { isHybridMemVersionOnlyInvocation } from "../index-version-cli.js";
import { PLUGIN_ID } from "../utils/constants.js";
import {
  restoreStdoutAfterJsonCli,
  wrapApiLoggerQuietForCli,
  wrapApiLoggerStderrForJsonCli,
} from "../utils/hybrid-mem-json-cli.js";
import {
  getCategoryDecisionRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getCategoryPreferenceRegex,
} from "../utils/language-keywords.js";
import { applyHybridMemQuietFlagFromArgv, initPluginLogger, pluginLogger } from "../utils/logger.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { findPluginRoot } from "../utils/plugin-root.js";
import { versionInfo } from "../versionInfo.js";
import {
  getHybridMemoryRegistrationState,
  resetHybridMemoryRegistrationStateForTests,
} from "./hybrid-memory-generation-state.js";
import {
  awaitDonorTeardown,
  clearTeardownTrackingForGeneration,
  drainOldBootstrap,
  drainOldRecall,
  getReloadTeardownQueueDepth,
  isTeardownDrainedForGeneration,
  resetReloadTeardownChainForTests,
  schedulePluginTeardown,
  TEARDOWN_WAIT_MS,
} from "./hybrid-memory-reload-coordinator.js";
import {
  awaitActivationReady,
  beginActivation,
  isActivationAborted,
  markActivationFailed,
  markActivationReady,
  resetActivationStateForTests,
} from "./hybrid-memory-activation.js";
import {
  _resetLastSuccessfulExtensionPathForTests,
  buildExtensionLoadContext,
  getLastSuccessfulExtensionPath,
  PluginLoadPreflightError,
  preflightExtensionIntegrity,
  recordSuccessfulExtensionLoad,
} from "./plugin-load-preflight.js";
import { createPluginService } from "./plugin-service.js";
import { registerContextEngineBestEffort } from "./register-context-engine.js";
import { registerLifecycleHooks } from "./register-hooks.js";
import {
  bindActivatedToolExecutors,
  registerActivationToolStubs,
  registerTools,
  type ToolRegistrationHandle,
} from "./register-tools.js";
import {
  databaseContextFromRuntime,
  evaluateReregisterReuse,
  recordReregisterDatabaseReuse,
  recordReregisterFullTeardown,
  recordReregisterRegistration,
  resetReregisterPolicyForTests,
  resolveReregisterPolicy,
} from "./reregister-policy.js";

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
    r.vaultRegistry?.closeAll();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "hybrid-mem-teardown:close-vaults",
    });
  }
  // Best-effort: give a fire-and-forget auto-optimize (#2081) a short window to finish before
  // close() tears the connection down under it. Bounded so a slow/hung native optimize can never
  // block one-shot CLI process exit. The 5s window only covers the short internal auto-optimize
  // triggered by store() — an explicit `vectordb-optimize`/`storage repair` run can legitimately
  // still be in progress after 5s (optimize() itself waits up to VECTORDB_OPTIMIZE_TIMEOUT_MS,
  // 10min by default). If one is still running, skip the synchronous vectorDb.close() rather than
  // yanking the connection out from under an in-flight native compaction — the native call
  // releases its own locks once it finishes, exactly as optimize()'s own timeout-path log message
  // promises; every other store still closes normally.
  await r.vectorDb?.waitForPendingOptimize?.(5_000);
  const vectorDbStillOptimizing = r.vectorDb?.isOptimizing?.() ?? false;
  if (vectorDbStillOptimizing) {
    pluginLogger.warn(
      "memory-hybrid: skipping vectorDb.close() at CLI teardown — a native optimize is still running in the " +
        "background and will release its locks once it finishes",
    );
  }
  try {
    closeOldDatabases({
      factsDb: r.factsDb,
      edictStore: r.edictStore,
      narrativesDb: r.narrativesDb,
      vectorDb: vectorDbStillOptimizing ? null : r.vectorDb,
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
  stopEventLoopLagMonitor();
}

/**
 * Close every handle a registration attempt just opened, after `runtimeRef.value` was already
 * advanced to it but tool/CLI/hook registration then threw (loop iteration 128 fix). Without
 * this, `registerTools`/`registerHybridMemCliWithApi`/`registerLifecycleHooks` each only logged
 * and rethrew on failure, leaking every DB/service handle `newRuntime` had just opened -- every
 * retry (e.g. a host re-attempting `register()` after a transient failure) leaked another set.
 * Mirrors `performHybridMemCliTeardown`'s non-reuse cleanup shape.
 */
function closeFailedRegistrationRuntime(runtime: PluginRuntime): void {
  clearRuntimeTimers(runtime.timers);
  try {
    runtime.lifecycleHooksHandle?.dispose();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:failed-cleanup:dispose-hooks",
    });
  }
  try {
    runtime.toolRegistrationHandle?.dispose();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:failed-cleanup:dispose-tools",
    });
  }
  try {
    runtime.vaultRegistry?.closeAll();
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:failed-cleanup:close-vaults",
    });
  }
  try {
    closeOldDatabases({
      factsDb: runtime.factsDb,
      edictStore: runtime.edictStore,
      narrativesDb: runtime.narrativesDb,
      vectorDb: runtime.vectorDb,
      credentialsDb: runtime.credentialsDb,
      proposalsDb: runtime.proposalsDb,
      identityReflectionStore: runtime.identityReflectionStore,
      personaStateStore: runtime.personaStateStore,
      eventLog: runtime.eventLog,
      aliasDb: runtime.aliasDb,
      eventBus: runtime.eventBus,
      issueStore: runtime.issueStore,
      workflowStore: runtime.workflowStore,
      crystallizationStore: runtime.crystallizationStore,
      toolProposalStore: runtime.toolProposalStore,
      verificationStore: runtime.verificationStore,
      provenanceService: runtime.provenanceService,
      learningsDb: runtime.learningsDb,
      apitapStore: runtime.apitapStore,
      auditStore: runtime.auditStore,
      agentHealthStore: runtime.agentHealthStore,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:failed-cleanup:close-databases",
    });
  }
  runtime.pythonBridge?.shutdown().catch((err: unknown) => {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:failed-cleanup:python-bridge-shutdown",
      severity: "warning",
    });
  });
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

  // `--version` should be fast, deterministic, and side-effect-free (issue #2012): no DB
  // bootstrap, no live config parse. Checked before the other fast paths since it is the
  // lightest — it registers no subcommands at all (see PR #2013 review on why `--version`/
  // `--json` cannot be root-level Commander options in the full command tree).
  if (isHybridMemVersionOnlyInvocation(process.argv)) {
    registerHybridMemCliVersionOnlyWithApi(api);
    return;
  }

  // Upgrade-only path skips DB bootstrap and live config parse (issue #2000).
  if (isHybridMemUpgradeOnlyInvocation(process.argv)) {
    registerHybridMemCliUpgradeOnlyWithApi(api);
    return;
  }

  // Vault-only commands need CredentialsDB + config only (issue #1883).
  if (isHybridMemCredentialsOnlyInvocation(process.argv)) {
    registerHybridMemCliCredentialsOnlyWithApi(api);
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
  // Issue #2095: a bare `--quiet`/`-q` flag is equivalent to OPENCLAW_HYBRID_MEM_QUIET=1, set here
  // (before the env var is first consulted below) so operators don't have to know the env var name.
  applyHybridMemQuietFlagFromArgv(process.argv);
  // Issue #1230 / #1234 / #1882: machine-output CLI must not write plugin telemetry to stdout.
  // Wrap api.logger to stderr before bootstrap; keep pluginLogger on that same logger delegate.
  // Issue #2095: OPENCLAW_HYBRID_MEM_QUIET=1 further drops info/debug bootstrap noise; composed
  // on top so it still respects the --json stderr redirect when both are set.
  const logApi = wrapApiLoggerQuietForCli(wrapApiLoggerStderrForJsonCli(api));
  initPluginLogger(logApi.logger, false);

  // Reopen guard: ensure any previous instance is closed before creating new one (avoids duplicate
  // DB instances if host calls register() before stop(), e.g. on SIGUSR1 or rapid reload).
  const old = runtimeRef.value;

  let cfg: HybridMemoryConfig;
  let parsedCfgSnapshot: HybridMemoryConfig;
  try {
    cfg = parseHybridMemPluginConfig(logApi);
    // Re-parse from raw plugin config so snapshot matches a fresh register() parse (structuredClone
    // drops non-enumerable fields such as credentials.encryptionKey).
    parsedCfgSnapshot = parseHybridMemPluginConfig(logApi);
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
  // Generation that produced the donor runtime we're about to supersede. Used by the reload
  // coordinator to track which scheduled teardowns the new register is actually waiting on
  // (rapid hot-reload guard, supplements #1550 / #2058 / #2059).
  const donorGeneration = old?.bootRegistrationGeneration ?? -1;

  const reusePolicy = resolveReregisterPolicy();
  const reuseDecision = evaluateReregisterReuse(old, cfg, logApi);
  const reuseDatabases = reuseDecision.reuse;
  if (old && reusePolicy === "reuse-databases" && !reuseDatabases) {
    // Surface the exact named reason (#2136) so a full teardown under reuse-databases is never
    // unexplained — this is what the `full_teardown_despite_reuse_policy` leak hint points at.
    logApi.logger.warn?.(
      `memory-hybrid: re-register falling back to full teardown despite reuse-databases policy (reason=${reuseDecision.reason})`,
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
    // The new registration always creates a fresh VaultRegistry (never reuses the old one, even
    // when reuseDatabases is true), so old named-vault handles are always orphaned here. Unlike
    // that, recallInFlightRef is a single counter shared by every recall call regardless of which
    // vault it targets — closing named-vault DB handles immediately (as opposed to the default
    // vault's databases, which drain via schedulePluginTeardown below) could close a vault
    // connection out from under an in-flight recall/store against that vault. Drain first.
    const oldVaultRegistry = old.vaultRegistry;
    const oldRecallInFlightRef = old.recallInFlightRef;
    if (oldVaultRegistry) {
      schedulePluginTeardown(
        async () => {
          try {
            await drainOldRecall(oldRecallInFlightRef);
            oldVaultRegistry.closeAll();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "registration",
              operation: "plugin-reregister:close-vaults",
              severity: "warning",
            });
          }
        },
        { donorGeneration },
      );
    }
    if (reuseDatabases) {
      recordReregisterDatabaseReuse();
      logApi.logger.debug?.(
        `memory-hybrid: re-register reusing database handles (policy=${resolveReregisterPolicy()})`,
      );
    } else {
      recordReregisterFullTeardown(reuseDecision.reason);
      const oldRuntime = old;
      old.pythonBridge?.shutdown().catch((err) => {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "plugin-reregister:python-bridge-shutdown",
          severity: "warning",
        });
      });
      // Let in-flight bootstrap (vault check, embedding verify) finish before permanentClose (#1550 reload race).
      schedulePluginTeardown(
        async () => {
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
        },
        { donorGeneration },
      );
    }
    runtimeRef.value = null;
  }

  // Resolve where this plugin generation was loaded from (staging path awareness, #2135). Diagnostic
  // context assembled BEFORE any native store init so a subsequent crash is attributable.
  let extensionPath = "unknown";
  try {
    extensionPath = findPluginRoot(import.meta.url);
  } catch {
    // Leave "unknown"; the preflight below turns this into a recoverable, named error.
  }
  const loadContext = buildExtensionLoadContext(extensionPath);
  const wasReregister = old != null;
  // Full-teardown re-register must not open DBs until donor teardown drains — but that drain is
  // Promise-based and cannot be awaited synchronously (#2181 / Atomics.wait starvation). Defer
  // DB open + live tool bind to Phase B. Reuse keeps donor handles and stays fully synchronous.
  const needsDeferredActivation = wasReregister && !donorRuntime;

  const loadDiagnosticsContext: Record<string, Record<string, unknown>> = {
    plugin_load: {
      packageVersion: loadContext.packageVersion,
      extensionPath: loadContext.extensionPath,
      isStaging: loadContext.isStaging,
      lastSuccessfulExtensionPath: getLastSuccessfulExtensionPath(),
      reusingDonorHandles: Boolean(donorRuntime),
      donorGenerationTeardownDrained: old ? isTeardownDrainedForGeneration(donorGeneration) : null,
      registrationGeneration,
      deferredActivation: needsDeferredActivation,
      teardownQueueDepth: getReloadTeardownQueueDepth(),
    },
  };

  if (needsDeferredActivation) {
    const preflight = preflightExtensionIntegrity(extensionPath);
    if (!preflight.ok) {
      const preflightError = new PluginLoadPreflightError(preflight, loadContext);
      capturePluginError(preflightError, {
        subsystem: "registration",
        operation: "plugin-register:load-preflight",
        tags: { preflight_reason: preflight.reason, staging: loadContext.isStaging },
        contexts: loadDiagnosticsContext,
      });
      logApi.logger.error?.(preflightError.message);
      throw preflightError;
    }

    beginActivation({ generation: registrationGeneration, donorGeneration });
    const stubHandle = registerActivationToolStubs(
      {
        registrationGeneration,
        currentRegistrationGenerationRef: registrationGenerationRef,
      },
      logApi,
    );

    // Host calls start() once after sync register(). Wait for Phase B, then start the real service.
    let activatedService: ReturnType<typeof createPluginService> | null = null;
    try {
      api.registerService({
        id: PLUGIN_ID,
        start: async () => {
          const ready = await awaitActivationReady(registrationGeneration, TEARDOWN_WAIT_MS + 15_000);
          if (!ready || isActivationAborted(registrationGeneration)) {
            logApi.logger.warn?.(
              `memory-hybrid: plugin-service start skipped — activation not ready for generation ${registrationGeneration}`,
            );
            return;
          }
          const rt = runtimeRef.value;
          if (!rt || rt.bootRegistrationGeneration !== registrationGeneration) return;
          activatedService = createPluginService({
            PLUGIN_ID,
            bootRegistrationGeneration: registrationGeneration,
            factsDb: rt.factsDb,
            edictStore: rt.edictStore,
            vectorDb: rt.vectorDb,
            embeddings: rt.embeddings,
            embeddingRegistry: rt.embeddingRegistry,
            credentialsDb: rt.credentialsDb,
            proposalsDb: rt.proposalsDb,
            wal: rt.wal,
            eventLog: rt.eventLog,
            cfg: rt.cfg,
            openai: rt.openai,
            resolvedLancePath: rt.resolvedLancePath,
            resolvedSqlitePath: rt.resolvedSqlitePath,
            api: logApi,
            timers: rt.timers,
            pythonBridge: rt.pythonBridge,
            provenanceService: rt.provenanceService,
            costTracker: rt.costTracker,
            auditStore: rt.auditStore ?? null,
            agentHealthStore: rt.agentHealthStore ?? null,
            verificationStore: rt.verificationStore ?? null,
            issueStore: rt.issueStore ?? null,
            serendipityStore: rt.serendipityStore ?? null,
            loomStore: rt.loomStore ?? null,
            workflowStore: rt.workflowStore ?? null,
            narrativesDb: rt.narrativesDb ?? null,
            crystallizationStore: rt.crystallizationStore ?? null,
            toolProposalStore: rt.toolProposalStore ?? null,
            changeFeed: rt.changeFeed,
            eventBus: rt.eventBus,
            identityReflectionStore: rt.identityReflectionStore,
            personaStateStore: rt.personaStateStore,
            learningsDb: rt.learningsDb,
            apitapStore: rt.apitapStore,
            aliasDb: rt.aliasDb,
            vaultRegistry: rt.vaultRegistry,
          });
          await activatedService.start();
        },
        stop: async () => {
          const stopFn = activatedService && "stop" in activatedService ? activatedService.stop : null;
          if (typeof stopFn === "function") await stopFn.call(activatedService);
        },
      });
    } catch (err) {
      stubHandle.dispose();
      markActivationFailed(registrationGeneration, err);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:service-deferred",
      });
      throw err;
    }

    logApi.logger.info?.(
      `memory-hybrid: re-register generation ${registrationGeneration} entering deferred activation ` +
        `(donorGeneration=${donorGeneration}, teardownQueueDepth=${getReloadTeardownQueueDepth()}, ` +
        `reason=${reuseDecision.reason}) — tools return initializing until Phase B completes`,
    );

    setImmediate(() => {
      void runDeferredFullTeardownActivation({
        api: logApi,
        cfg,
        parsedCfgSnapshot,
        registrationGeneration,
        donorGeneration,
        extensionPath,
        loadContext,
        loadDiagnosticsContext,
        stubHandle,
        wasReregister,
      });
    });
    return;
  }

  // Only preflight a FRESH open — the reuse path inherits already-open donor handles and performs no
  // native connect, so it cannot SIGBUS on a partial staging copy. A structurally incomplete staging
  // directory (missing/zero-byte/corrupt manifest) is rejected here, before the native LanceDB path,
  // converting a would-be native abort into a recoverable plugin-load error (#2135).
  if (!donorRuntime) {
    const preflight = preflightExtensionIntegrity(extensionPath);
    if (!preflight.ok) {
      const preflightError = new PluginLoadPreflightError(preflight, loadContext);
      capturePluginError(preflightError, {
        subsystem: "registration",
        operation: "plugin-register:load-preflight",
        tags: { preflight_reason: preflight.reason, staging: loadContext.isStaging },
        contexts: loadDiagnosticsContext,
      });
      logApi.logger.error?.(preflightError.message);
      throw preflightError;
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
    // Attach the load context (#2135) so an init failure during a staging/hot-upgrade load reports
    // the package version, staging path, last-successful path, and reload/teardown state — instead
    // of failing (or crashing) with no attribution.
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:init-databases",
      tags: { staging: loadContext.isStaging, package_version: loadContext.packageVersion },
      contexts: loadDiagnosticsContext,
    });
    throw err;
  }

  finishHybridMemoryRegistration({
    api: logApi,
    cfg,
    parsedCfgSnapshot,
    registrationGeneration,
    donorGeneration,
    donorRuntime,
    dbContext,
    extensionPath,
    wasReregister,
    toolMode: "sync",
  });
}

type FinishRegistrationParams = {
  api: ClawdbotPluginApi;
  cfg: HybridMemoryConfig;
  parsedCfgSnapshot: HybridMemoryConfig;
  registrationGeneration: number;
  donorGeneration: number;
  donorRuntime: PluginRuntime | null;
  dbContext: ReturnType<typeof initializeDatabases>;
  extensionPath: string;
  wasReregister: boolean;
  toolMode: "sync" | "bind-live";
  stubHandle?: ToolRegistrationHandle;
};

async function runDeferredFullTeardownActivation(params: {
  api: ClawdbotPluginApi;
  cfg: HybridMemoryConfig;
  parsedCfgSnapshot: HybridMemoryConfig;
  registrationGeneration: number;
  donorGeneration: number;
  extensionPath: string;
  loadContext: ReturnType<typeof buildExtensionLoadContext>;
  loadDiagnosticsContext: Record<string, Record<string, unknown>>;
  stubHandle: ToolRegistrationHandle;
  wasReregister: boolean;
}): Promise<void> {
  const {
    api: logApi,
    cfg,
    parsedCfgSnapshot,
    registrationGeneration,
    donorGeneration,
    extensionPath,
    loadContext,
    loadDiagnosticsContext,
    stubHandle,
    wasReregister,
  } = params;

  const startedAt = Date.now();
  try {
    if (isActivationAborted(registrationGeneration)) {
      stubHandle.dispose();
      return;
    }

    const drained = await awaitDonorTeardown(donorGeneration, TEARDOWN_WAIT_MS);
    if (isActivationAborted(registrationGeneration)) {
      stubHandle.dispose();
      return;
    }

    if (!drained) {
      logApi.logger.warn?.(
        `memory-hybrid: donor generation ${donorGeneration} teardown still pending after ${TEARDOWN_WAIT_MS}ms; ` +
          `opening fresh databases anyway (prior teardown continues on its own chain) [generation=${registrationGeneration}]`,
      );
    }

    logApi.logger.info?.(
      `memory-hybrid: deferred activation Phase B opening databases (generation=${registrationGeneration}, donorGeneration=${donorGeneration}, drained=${drained}, waitedMs=${Date.now() - startedAt}, teardownQueueDepth=${getReloadTeardownQueueDepth()})`,
    );

    let dbContext: ReturnType<typeof initializeDatabases>;
    try {
      dbContext = initializeDatabases(cfg, logApi, { bootRegistrationGeneration: registrationGeneration });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:init-databases-deferred",
        tags: { staging: loadContext.isStaging, package_version: loadContext.packageVersion },
        contexts: loadDiagnosticsContext,
      });
      stubHandle.dispose();
      markActivationFailed(registrationGeneration, err);
      throw err;
    }

    if (isActivationAborted(registrationGeneration)) {
      closeOldDatabases({
        factsDb: dbContext.factsDb,
        edictStore: dbContext.edictStore,
        vectorDb: dbContext.vectorDb,
        credentialsDb: dbContext.credentialsDb,
        proposalsDb: dbContext.proposalsDb,
        identityReflectionStore: dbContext.identityReflectionStore,
        personaStateStore: dbContext.personaStateStore,
        eventLog: dbContext.eventLog,
        narrativesDb: dbContext.narrativesDb,
        aliasDb: dbContext.aliasDb,
        issueStore: dbContext.issueStore,
        workflowStore: dbContext.workflowStore,
        crystallizationStore: dbContext.crystallizationStore,
        toolProposalStore: dbContext.toolProposalStore,
        verificationStore: dbContext.verificationStore,
        provenanceService: dbContext.provenanceService,
        apitapStore: dbContext.apitapStore,
      });
      stubHandle.dispose();
      return;
    }

    finishHybridMemoryRegistration({
      api: logApi,
      cfg,
      parsedCfgSnapshot,
      registrationGeneration,
      donorGeneration,
      donorRuntime: null,
      dbContext,
      extensionPath,
      wasReregister,
      toolMode: "bind-live",
      stubHandle,
    });
    markActivationReady(registrationGeneration);
    logApi.logger.info?.(
      `memory-hybrid: deferred activation ready (generation=${registrationGeneration}, totalMs=${Date.now() - startedAt})`,
    );
  } catch (err) {
    if (!isActivationAborted(registrationGeneration)) {
      markActivationFailed(registrationGeneration, err);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:deferred-activation",
        severity: "error",
      });
      logApi.logger.error?.(
        `memory-hybrid: deferred activation failed for generation ${registrationGeneration}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function finishHybridMemoryRegistration(params: FinishRegistrationParams): void {
  const {
    api: logApi,
    cfg,
    parsedCfgSnapshot,
    registrationGeneration,
    donorGeneration,
    donorRuntime,
    dbContext,
    extensionPath,
    wasReregister,
    toolMode,
    stubHandle,
  } = params;

  const { resolvedSqlitePath, resolvedLancePath } = dbContext;

  logApi.logger.info(
    `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
  );
  warnGraphRecallConfigMisconfiguration(cfg, (msg) => logApi.logger.warn?.(msg));
  startEventLoopLagMonitor();

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

  // Carried over from donorRuntime like every sibling optional service below (eventBus,
  // pythonBridge, learningsDb, auditStore, agentHealthStore) -- VariantGenerationQueue has no
  // dispose/drain/shutdown method, so rebuilding it unconditionally on every register() call
  // (even a reuse-databases hot-reload triggered by an unrelated config change) silently
  // discarded any contextual-variant-generation work still queued on the old instance, with no
  // warning or retry (#2067-followup).
  let variantQueue: VariantGenerationQueue | null = donorRuntime?.variantQueue ?? null;
  if (cfg.contextualVariants.enabled && !variantQueue) {
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

  let changeFeed: ChangeFeed | null = null;
  try {
    changeFeed = new ChangeFeed(dbContext.factsDb);
    logApi.logger.info("memory-hybrid: change feed initialized");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:change-feed-init",
      severity: "warning",
    });
    changeFeed = null;
  }

  // ========================================================================
  // Build PluginRuntime -- single instance-scoped container for all state
  // ========================================================================

  const vaultRegistry =
    cfg.vaults && Object.keys(cfg.vaults).length > 0
      ? createVaultRegistry({
          cfg,
          api: logApi,
          defaultFactsDb: dbContext.factsDb,
          defaultVectorDb: dbContext.vectorDb,
          defaultSqlitePath: resolvedSqlitePath,
          defaultLancePath: resolvedLancePath,
          defaultWal: dbContext.wal,
          vectorDim: dbContext.embeddings.dimensions,
        })
      : null;
  const resolveVault = vaultRegistry ? (name?: string) => vaultRegistry.resolve(name) : undefined;
  const resolveAllVaults = vaultRegistry ? () => vaultRegistry.resolveAll() : undefined;
  const resolveVaultWal = vaultRegistry ? (name?: string) => vaultRegistry.resolveWal(name) : undefined;

  const bootstrapSettledRef = { value: false };
  const bootstrapAsyncInit = dbContext.initialized.finally(() => {
    bootstrapSettledRef.value = true;
  });

  // Universal at-formation enrichment (living-memory P2.1/P4.2): every newlyStored fact — from
  // ANY write path — gets neighbors (auto-links) and a PRECEDED_BY temporal chain, via the
  // factStored bus event. Idempotent; deps refresh on re-register.
  wirePostStoreEnrichment({
    factsDb: dbContext.factsDb,
    vectorDb: dbContext.vectorDb,
    cfg,
    logger: logApi.logger,
  });

  const newRuntime: PluginRuntime = {
    cfg,
    parsedCfgSnapshot,
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
    serendipityStore: dbContext.serendipityStore,
    loomStore: dbContext.loomStore,
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
    changeFeed,
    resolveVault,
    resolveAllVaults,
    resolveVaultWal,
    vaultRegistry,
    sessionStateRef: { value: null },
    lifecycleHooksHandle: null, // set after registerLifecycleHooks below
    toolRegistrationHandle: null, // set after registerTools below
    bootstrapAsyncInit,
    bootstrapSettledRef,
    bootstrapHealth: dbContext.health,
    bootRegistrationGeneration: registrationGeneration,
    pendingLLMWarnings: createPendingLLMWarnings(),
    currentAgentIdRef: { value: null },
    restartPendingClearedRef: { value: false },
    recallInFlightRef: { value: 0 },
    lastAutoRecallPromptRef: { value: null },
    prependBudgetRef: { value: null },
    beforeAgentStartTurnRef: { value: null },
    lastProgressiveIndexIds: [],
    progressiveIndexBySession: new Map(),
    lastAutoRecallPromptBySession: new Map(),
    injectedFactIdsBySession: new Map(),
    timers: createTimers(),
  };

  runtimeRef.value = newRuntime;

  // The donor generation's tracking is no longer needed: even if its teardown is still
  // queued behind a newer one, the new runtime is now in place and the donor's `done`
  // promises are no longer observed by anyone.
  if (donorGeneration >= 0) {
    clearTeardownTrackingForGeneration(donorGeneration);
  }

  const runtime = newRuntime;

  // ContextEngine Plugin Slot (Issue #273) — register immediately after runtime bootstrap
  // so the host's first resolve attempt wins the cold-start race (before tools/CLI/hooks).
  registerContextEngineBestEffort({
    runtime,
    logger: logApi.logger,
    pluginVersion: versionInfo.pluginVersion,
    registerContextEngine:
      typeof logApi.registerContextEngine === "function" ? logApi.registerContextEngine.bind(logApi) : undefined,
  });

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
    serendipityStore: runtime.serendipityStore ?? null,
    loomStore: runtime.loomStore ?? null,
    workflowStore: runtime.workflowStore,
    crystallizationStore: runtime.crystallizationStore,
    toolProposalStore: runtime.toolProposalStore,
    verificationStore: runtime.verificationStore,
    variantQueue: runtime.variantQueue,
    lastProgressiveIndexIds: runtime.lastProgressiveIndexIds,
    progressiveIndexBySession: runtime.progressiveIndexBySession,
    lastAutoRecallPromptBySession: runtime.lastAutoRecallPromptBySession,
    injectedFactIdsBySession: runtime.injectedFactIdsBySession,
    currentAgentIdRef: runtime.currentAgentIdRef,
    restartPendingClearedRef: runtime.restartPendingClearedRef,
    recallInFlightRef: runtime.recallInFlightRef,
    lastAutoRecallPromptRef: runtime.lastAutoRecallPromptRef,
    prependBudgetRef: runtime.prependBudgetRef,
    beforeAgentStartTurnRef: runtime.beforeAgentStartTurnRef,
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
    changeFeed: runtime.changeFeed,
    sessionStateRef: runtime.sessionStateRef,
    resolveVault: runtime.resolveVault,
    resolveAllVaults: runtime.resolveAllVaults,
    resolveVaultWal: runtime.resolveVaultWal,
  };

  // ========================================================================
  // Tools

  try {
    if (toolMode === "bind-live") {
      bindActivatedToolExecutors(pluginContext, logApi);
      // Keep Phase A stub handle so dispose() still unregisters host stubs on the next reload.
      runtime.toolRegistrationHandle = stubHandle ?? {
        dispose: () => {
          /* no-op */
        },
      };
    } else {
      runtime.toolRegistrationHandle = registerTools(pluginContext, logApi);
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:tools",
    });
    closeFailedRegistrationRuntime(runtime);
    if (runtimeRef.value === runtime) runtimeRef.value = null;
    stubHandle?.dispose();
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
        toolProposalStore: runtime.toolProposalStore ?? null,
        eventLog: runtime.eventLog,
        verificationStore: runtime.verificationStore,
        provenanceService: runtime.provenanceService,
        issueStore: runtime.issueStore ?? null,
        serendipityStore: runtime.serendipityStore ?? null,
        loomStore: runtime.loomStore ?? null,
        costTracker: runtime.costTracker,
        eventBus: runtime.eventBus,
        resolvedSqlitePath: runtime.resolvedSqlitePath,
        resolvedLancePath: runtime.resolvedLancePath,
        pluginId: PLUGIN_ID,
        detectCategory,
        auditStore: runtime.auditStore,
        agentHealthStore: runtime.agentHealthStore ?? null,
        changeFeed: runtime.changeFeed,
      },
      { onHybridMemCliComplete: () => performHybridMemCliTeardown() },
    );
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:cli",
    });
    closeFailedRegistrationRuntime(runtime);
    if (runtimeRef.value === runtime) runtimeRef.value = null;
    throw err;
  }

  // Lifecycle Hooks (issueStore may be null; issue-related behavior is gated inside hooks)
  try {
    runtime.lifecycleHooksHandle = registerLifecycleHooks(pluginContext, logApi);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:hooks",
    });
    closeFailedRegistrationRuntime(runtime);
    if (runtimeRef.value === runtime) runtimeRef.value = null;
    throw err;
  }

  // Service — deferred activation already registered a waiter service in Phase A that starts
  // the real service after markActivationReady. Sync/reuse path registers here.
  if (toolMode === "sync") {
    try {
      logApi.registerService(
        createPluginService({
          PLUGIN_ID,
          bootRegistrationGeneration: registrationGeneration,
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
          verificationStore: runtime.verificationStore ?? null,
          issueStore: runtime.issueStore ?? null,
          serendipityStore: runtime.serendipityStore ?? null,
          loomStore: runtime.loomStore ?? null,
          workflowStore: runtime.workflowStore ?? null,
          narrativesDb: runtime.narrativesDb ?? null,
          crystallizationStore: runtime.crystallizationStore ?? null,
          toolProposalStore: runtime.toolProposalStore ?? null,
          changeFeed: runtime.changeFeed,
          eventBus: runtime.eventBus,
          identityReflectionStore: runtime.identityReflectionStore,
          personaStateStore: runtime.personaStateStore,
          learningsDb: runtime.learningsDb,
          apitapStore: runtime.apitapStore,
          aliasDb: runtime.aliasDb,
          vaultRegistry: runtime.vaultRegistry,
        }),
      );
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:service",
      });
      throw err;
    }
  }

  // Issue #1893: OpenClaw does not re-run plugin-service.start() on hot reload; re-arm Workboard sync.
  if (wasReregister && cfg.workboard?.enabled) {
    void import("./workboard-integration.js")
      .then(({ scheduleWorkboardIntegrationAfterReregister }) => {
        scheduleWorkboardIntegrationAfterReregister({
          factsDb: runtime.factsDb,
          vectorDb: runtime.vectorDb,
          embeddings: runtime.embeddings,
          cfg: runtime.cfg,
          api: logApi,
          timers: runtime.timers,
          shouldAbort: () =>
            registrationGenerationRef.value !== registrationGeneration || runtime.timers.shuttingDownRef.value,
        });
      })
      .catch((err) => {
        logApi.logger.warn?.(
          `memory-hybrid: Workboard re-register arm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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

  // Synchronous registration completed without throwing — record this generation's load path as the
  // last-known-good extension path so a future crashing staging load can report what last worked (#2135).
  recordSuccessfulExtensionLoad(extensionPath);
}

export { detectCategory, performHybridMemCliTeardown, runtimeRef, shouldCapture };
export { awaitActivationReady, getActivationState } from "./hybrid-memory-activation.js";

/** Reset plugin singleton state between vitest cases (runtime, reload chain, generation). */
export function resetPluginRegistrationStateForTests(): void {
  const old = runtimeRef.value;
  if (old) {
    clearRuntimeTimers(old.timers);
    try {
      old.lifecycleHooksHandle?.dispose();
    } catch {
      /* non-fatal */
    }
    try {
      old.toolRegistrationHandle?.dispose();
    } catch {
      /* non-fatal */
    }
    runtimeRef.value = null;
  }
  resetActivationStateForTests();
  resetReloadTeardownChainForTests();
  resetReregisterPolicyForTests();
  resetHybridMemoryRegistrationStateForTests();
  _resetLastSuccessfulExtensionPathForTests();
}
