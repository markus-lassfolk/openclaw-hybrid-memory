import type { PluginRuntime } from "../api/plugin-runtime.js";
import type { ContextEngineRegistrar } from "../services/context-engine.js";
import { capturePluginError } from "../services/error-reporter.js";

type ContextEngineRegistrationRuntime = Pick<
  PluginRuntime,
  "factsDb" | "vectorDb" | "wal" | "embeddings" | "cfg" | "injectedFactIdsBySession"
>;

type ContextEngineRegistrar = (opts: {
  factsDb: ContextEngineRegistrationRuntime["factsDb"];
  vectorDb: ContextEngineRegistrationRuntime["vectorDb"];
  wal: ContextEngineRegistrationRuntime["wal"];
  embeddings: ContextEngineRegistrationRuntime["embeddings"];
  cfg: ContextEngineRegistrationRuntime["cfg"];
  injectedFactIdsBySession: ContextEngineRegistrationRuntime["injectedFactIdsBySession"];
  logger: { warn?: (message: string) => void };
  pluginVersion: string;
}) => unknown;

type ContextEngineLoader = () => Promise<{
  registerHybridContextEngine: ContextEngineRegistrar;
}>;

export function registerContextEngineBestEffort(args: {
  runtime: ContextEngineRegistrationRuntime;
  logger: { warn?: (message: string) => void };
  pluginVersion: string;
  registerContextEngine?: ContextEngineRegistrar;
  loadContextEngine?: ContextEngineLoader;
}): void {
  const { runtime, logger, pluginVersion, registerContextEngine } = args;
  const loadContextEngine = args.loadContextEngine ?? (() => import("../services/context-engine.js"));

  void loadContextEngine()
    .then(({ registerHybridContextEngine }) =>
      registerHybridContextEngine({
        factsDb: runtime.factsDb,
        vectorDb: runtime.vectorDb,
        wal: runtime.wal,
        embeddings: runtime.embeddings,
        cfg: runtime.cfg,
        injectedFactIdsBySession: runtime.injectedFactIdsBySession,
        logger,
        pluginVersion,
        registerContextEngine,
      }),
    )
    .catch((err: unknown) => {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:context-engine",
      });
      logger.warn?.(`memory-hybrid: ContextEngine registration skipped: ${err}`);
    });
}
