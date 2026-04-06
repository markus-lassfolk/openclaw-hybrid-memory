/**
 * Tool Registration Wiring
 *
 * Registers all plugin tools with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { type ToolsContext, toolInstallers } from "./tool-installers.js";

/** Tool registration receives the stable plugin API (Phase 3). */
/**
 * Register all plugin tools with the OpenClaw API.
 * Calls tool registration modules in the correct order.
 *
 * Tool `name` strings must satisfy provider schemas (e.g. Anthropic:
 * `^[a-zA-Z0-9_-]{1,128}$` — letters, digits, underscore, hyphen only; no dots).
 */
export function registerTools(ctx: ToolsContext, api: ClawdbotPluginApi): void {
  for (const installer of toolInstallers) {
    installer.install(installer.selectContext(ctx, api), api);
  }
}
