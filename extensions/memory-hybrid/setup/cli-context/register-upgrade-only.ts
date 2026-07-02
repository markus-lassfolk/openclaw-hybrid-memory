import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { runUpgradeForCli } from "../../cli/install/run-install.js";
import type { HandlerContext } from "../../cli/handlers.js";
import { hybridConfigSchema } from "../../config.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";
import { attachHybridMemCliFatalExit } from "../../cli/hybrid-mem-commander-utils.js";
import { withExit } from "../../cli/shared.js";
import { resetPluginLogger, restoreDefaultLogger } from "../../utils/logger.js";

/**
 * Upgrade-only CLI wiring (issue #2000).
 *
 * Skips DB bootstrap and config secrets resolution so `openclaw hybrid-mem upgrade` can run
 * when full registration would fail on config parse — but only when OpenClaw already loaded the plugin.
 */
export function registerHybridMemCliUpgradeOnlyWithApi(api: ClawdbotPluginApi): void {
  resetPluginLogger();
  let cfg: HandlerContext["cfg"];
  try {
    cfg = hybridConfigSchema.parse({
      embedding: {
        provider: "openai",
        apiKey: "sk-upgrade-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
    });
  } catch {
    cfg = hybridConfigSchema.parse({
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
      },
    });
  } finally {
    restoreDefaultLogger();
  }

  const handlerCtx: HandlerContext = {
    cfg,
    logger: api.logger,
    api,
    factsDb: null as unknown as HandlerContext["factsDb"],
    vectorDb: null as unknown as HandlerContext["vectorDb"],
    embeddings: null as unknown as HandlerContext["embeddings"],
    openai: null as unknown as HandlerContext["openai"],
    credentialsDb: null,
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
    resolvedSqlitePath: api.resolvePath(cfg.sqlitePath),
    resolvedLancePath: api.resolvePath(cfg.lanceDbPath),
    pluginId: "openclaw-hybrid-memory",
    detectCategory: (() => "fact") as HandlerContext["detectCategory"],
    costTracker: null,
    eventBus: null,
    auditStore: null,
    agentHealthStore: null,
    changeFeed: null,
  };

  api.registerCli(
    ({ program }: { program: Command }) => {
      const mem = program.command("hybrid-mem").description(HYBRID_MEM_CLI_ROOT_DESCRIPTOR.description);
      attachHybridMemCliFatalExit(mem);
      // `--version` is handled by a dedicated fast path (registerHybridMemCliVersionOnlyWithApi,
      // issue #2012), not registered here — a root `--version`/`--json` option previously shadowed
      // this "upgrade" subcommand's own flags (PR #2013 review).
      mem
        .command("upgrade [version]")
        .description("Upgrade hybrid-mem to a specific version (or latest). Downloads and installs plugin from npm.")
        .action(
          withExit(async (version?: string) => {
            const res = await runUpgradeForCli(handlerCtx, version, { skipPostUpgradeCron: true });
            if (res.ok) {
              console.log(`Upgraded to version ${res.version}. Plugin installed at: ${res.pluginDir}`);
              if (res.workspaceSkillPath) {
                console.log(`Workspace skill: ${res.workspaceSkillPath}`);
              }
              if (res.workspaceToolsMdPath) {
                console.log(`TOOLS.md: ${res.workspaceToolsMdPath}`);
              }
            } else {
              console.error(`Error upgrading: ${res.error}`);
              process.exitCode = 1;
            }
          }),
        );
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
