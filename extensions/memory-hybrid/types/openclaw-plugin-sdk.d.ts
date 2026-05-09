/**
 * Type declarations for openclaw/plugin-sdk scoped subpaths.
 * The actual implementation is provided by the OpenClaw runtime at runtime.
 */
declare module "openclaw/plugin-sdk/core" {
  import type { OpenClawPluginApi as _OpenClawPluginApi } from "../plugins/types.js";

  // ClawdbotPluginApi is the local plugin API type — a named alias for the SDK's OpenClawPluginApi.
  // This preserves the plugin's existing type name while using the scoped subpath import.
  export type ClawdbotPluginApi = _OpenClawPluginApi;

  /** Optional SDK hook (OpenClaw ≥2026.5); feature-detected at runtime in `registerHybridContextEngine`. */
  export function registerContextEngine(id: string, factory: () => unknown): void;
}
