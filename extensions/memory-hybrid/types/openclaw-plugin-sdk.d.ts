/**
 * Type declarations for openclaw/plugin-sdk scoped subpaths.
 * The actual implementation is provided by the OpenClaw runtime at runtime.
 */
declare module "openclaw/plugin-sdk/core" {
  import type { OpenClawPluginApi as _OpenClawPluginApi } from "../plugins/types.js";

  // ClawdbotPluginApi is the local plugin API type — a named alias for the SDK's OpenClawPluginApi.
  // This preserves the plugin's existing type name while using the scoped subpath import.
  export type ClawdbotPluginApi = _OpenClawPluginApi;
}

// Also keep the barrel augmentation for backwards-compat (e.g. dynamic imports via import("openclaw/plugin-sdk"))
declare module "openclaw/plugin-sdk" {
  import type { OpenClawPluginApi as _OpenClawPluginApi } from "../plugins/types.js";
  export type ClawdbotPluginApi = _OpenClawPluginApi;
}
