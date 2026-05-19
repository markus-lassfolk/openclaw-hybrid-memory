import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";

/**
 * `loadOpenClawPluginCliRegistry` calls `register()` with `registrationMode: "cli-metadata"` only to
 * collect CLI metadata without activating the full plugin (issue #1111).
 */
export function registerHybridMemCliMetadataOnly(api: ClawdbotPluginApi): void {
  api.registerCli(
    () => {
      // Full Commander wiring runs on full registration or when a lazy placeholder loads this plugin.
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
