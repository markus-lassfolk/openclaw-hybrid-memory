import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HandlerContext } from "../../cli/handlers.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { createCredentialsDbForConfig } from "../../services/credentials-bootstrap.js";
import { restoreStdoutAfterJsonCli, wrapApiLoggerStderrForJsonCli } from "../../utils/hybrid-mem-json-cli.js";
import { initPluginLogger } from "../../utils/logger.js";
import { parseHybridMemPluginConfig } from "../parse-plugin-config.js";
import { buildCliContextServices, type HybridMemCliRegistrationContext } from "./cli-services.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";
import { createHybridMemCliContext } from "./register-help.js";
import { registerCliWithHelp } from "./register-cli-with-help.js";

/**
 * Credentials-only CLI wiring (issue #1883).
 *
 * Vault read/write commands only need parsed config, the resolved sqlite path, and CredentialsDB.
 * Skip vector DB, embeddings, LLM providers, optional stores, tools, hooks, and service bootstrap.
 */
export function registerHybridMemCliCredentialsOnlyWithApi(api: ClawdbotPluginApi): void {
  const logApi = wrapApiLoggerStderrForJsonCli(api);
  initPluginLogger(logApi.logger, false);

  let cfg: HandlerContext["cfg"];
  try {
    cfg = parseHybridMemPluginConfig(logApi);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:credentials-only-config-parse",
    });
    throw err;
  }

  const resolvedSqlitePath = logApi.resolvePath(cfg.sqlitePath);
  const resolvedLancePath = logApi.resolvePath(cfg.lanceDbPath);
  const credentialsDb = createCredentialsDbForConfig(cfg, resolvedSqlitePath);

  const stub: unknown = {};
  const cliRegistrationCtx: HybridMemCliRegistrationContext = {
    factsDb: stub as HandlerContext["factsDb"],
    vectorDb: stub as HandlerContext["vectorDb"],
    embeddings: stub as HandlerContext["embeddings"],
    openai: stub as HandlerContext["openai"],
    cfg,
    credentialsDb,
    aliasDb: null,
    wal: null,
    proposalsDb: null,
    identityReflectionStore: null,
    personaStateStore: null,
    crystallizationStore: null,
    toolProposalStore: null,
    eventLog: null,
    verificationStore: null,
    provenanceService: null,
    issueStore: null,
    resolvedSqlitePath,
    resolvedLancePath,
    pluginId: "openclaw-hybrid-memory",
    detectCategory: (() => "fact") as HandlerContext["detectCategory"],
    costTracker: null,
    eventBus: null,
    auditStore: null,
    agentHealthStore: null,
    changeFeed: null,
  };

  const handlerCtx: HandlerContext = {
    ...cliRegistrationCtx,
    logger: logApi.logger,
    api: logApi,
  };

  const services = buildCliContextServices(cliRegistrationCtx, logApi);
  logApi.registerCli(
    ({ program }: { program: Command }) => {
      try {
        const cliCtx = createHybridMemCliContext(handlerCtx, logApi, services);
        registerCliWithHelp(program, cliCtx, {
          onHybridMemCliComplete: async () => {
            restoreStdoutAfterJsonCli();
            try {
              credentialsDb?.permanentClose();
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "credentials-only-teardown:close-vault",
              });
            }
          },
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "register-cli:credentials-only-callback",
        });
        throw err;
      }
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
