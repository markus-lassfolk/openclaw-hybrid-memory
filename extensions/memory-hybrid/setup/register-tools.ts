/**
 * Tool Registration Wiring
 *
 * Registers all plugin tools with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ToolInstallerContext } from "./tool-installers.js";
import { toolInstallers } from "./tool-installers.js";

/** Tool registration receives the stable plugin API (Phase 3). */
export type ToolsContext = ToolInstallerContext;

/**
 * Register all plugin tools with the OpenClaw API.
 * Calls tool registration modules in the correct order.
 */
export function registerTools(ctx: ToolsContext, api: ClawdbotPluginApi): void {
  for (const installer of toolInstallers) {
    installer.install(ctx, api);
  }
}
