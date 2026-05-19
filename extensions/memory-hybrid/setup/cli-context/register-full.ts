import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HandlerContext } from "../../cli/handlers.js";
import { capturePluginError } from "../../services/error-reporter.js";

import { buildCliContextServices, type HybridMemCliRegistrationContext } from "./cli-services.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";
import { createHybridMemCliContext } from "./register-help.js";
import { registerCliWithHelp } from "./register-cli-with-help.js";
export type RegisterHybridMemCliWithApiOptions = {
  /**
   * Called after a `hybrid-mem` subcommand action completes (Commander `postAction` on the
   * `hybrid-mem` command). Used to close LanceDB/SQLite and dispose timers so one-shot CLI
   * processes can exit (Issue #1039).
   */
  onHybridMemCliComplete?: () => void | Promise<void>;
};

/**
 * Register hybrid-mem CLI with the API. Call from index after DB init.
 * Builds handler context and services inside setup so index stays a thin orchestrator.
 */
export function registerHybridMemCliWithApi(
  api: ClawdbotPluginApi,
  ctx: HybridMemCliRegistrationContext,
  options?: RegisterHybridMemCliWithApiOptions,
): void {
  const handlerCtx: HandlerContext = {
    ...ctx,
    logger: api.logger,
    api,
  };
  const services = buildCliContextServices(ctx, api);
  api.registerCli(
    ({ program }: { program: Command }) => {
      try {
        const cliCtx = createHybridMemCliContext(handlerCtx, api, services);
        registerCliWithHelp(program, cliCtx, options);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "register-cli:callback",
        });
        throw err;
      }
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
