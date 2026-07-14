import type { PluginRuntime } from "../api/plugin-runtime.js";
import {
  registerHybridContextEngine,
  registerHybridContextEngineSync,
  type ContextEngineRegistrar,
} from "../services/context-engine.js";
import { capturePluginError } from "../services/error-reporter.js";

type ContextEngineRegistrationRuntime = Pick<
  PluginRuntime,
  "factsDb" | "vectorDb" | "wal" | "embeddings" | "cfg" | "injectedFactIdsBySession"
>;

function buildContextEngineOptions(args: {
  runtime: ContextEngineRegistrationRuntime;
  logger: { warn?: (message: string) => void };
  pluginVersion: string;
  registerContextEngine?: ContextEngineRegistrar;
}) {
  const { runtime, logger, pluginVersion, registerContextEngine } = args;
  return {
    factsDb: runtime.factsDb,
    vectorDb: runtime.vectorDb,
    wal: runtime.wal,
    embeddings: runtime.embeddings,
    cfg: runtime.cfg,
    injectedFactIdsBySession: runtime.injectedFactIdsBySession,
    logger,
    pluginVersion,
    registerContextEngine,
  };
}

function reportContextEngineRegistrationFailure(err: unknown, logger: { warn?: (message: string) => void }): void {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
    subsystem: "registration",
    operation: "plugin-register:context-engine",
  });
  logger.warn?.(`memory-hybrid: ContextEngine registration skipped: ${err}`);
}

export function registerContextEngineBestEffort(args: {
  runtime: ContextEngineRegistrationRuntime;
  logger: { warn?: (message: string) => void };
  pluginVersion: string;
  registerContextEngine?: ContextEngineRegistrar;
}): void {
  const opts = buildContextEngineOptions(args);

  // Sync path: host exposes api.registerContextEngine — register before tools/CLI/hooks
  // so the first host resolve attempt sees hybrid-memory (cold-start race #273).
  if (typeof args.registerContextEngine === "function") {
    try {
      registerHybridContextEngineSync(opts);
    } catch (err: unknown) {
      reportContextEngineRegistrationFailure(err, args.logger);
    }
    return;
  }

  // Async fallback for older hosts that only export registerContextEngine from the SDK.
  void registerHybridContextEngine(opts).catch((err: unknown) => {
    reportContextEngineRegistrationFailure(err, args.logger);
  });
}
