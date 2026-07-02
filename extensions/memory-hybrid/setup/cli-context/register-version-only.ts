import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { attachHybridMemCliFatalExit } from "../../cli/hybrid-mem-commander-utils.js";
import { registerHybridMemVersionFlag } from "../../cli/register-hybrid-mem-version-flag.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";

/**
 * Version-only CLI wiring for `openclaw hybrid-mem --version` (issue #2012).
 *
 * Registers a `hybrid-mem` command with only the `--version`/`--json` flags and no
 * subcommands, so there is no full command tree for those flags to collide with (PR #2013
 * review — a root-level `--version`/`--json` option previously shadowed the identically-named
 * option on subcommands like `upgrade`/`list`). It also skips config parsing and DB bootstrap
 * entirely, so `--version` stays fast and works even when the plugin config is incomplete.
 */
export function registerHybridMemCliVersionOnlyWithApi(api: ClawdbotPluginApi): void {
  api.registerCli(
    ({ program }: { program: Command }) => {
      const mem = program.command("hybrid-mem").description(HYBRID_MEM_CLI_ROOT_DESCRIPTOR.description);
      attachHybridMemCliFatalExit(mem);
      registerHybridMemVersionFlag(mem);
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
