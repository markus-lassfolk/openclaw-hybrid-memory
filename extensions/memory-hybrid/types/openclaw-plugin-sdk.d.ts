/**
 * Type declarations for openclaw/plugin-sdk scoped subpaths.
 * The actual implementation is provided by the OpenClaw runtime at runtime.
 */
declare module "openclaw/plugin-sdk/core" {
  import type { OpenClawPluginApi as _OpenClawPluginApi } from "../plugins/types.js";

  // ClawdbotPluginApi is the local plugin API type — a named alias for the SDK's OpenClawPluginApi.
  // This preserves the plugin's existing type name while using the scoped subpath import.
  export type ClawdbotPluginApi = _OpenClawPluginApi & {
    /** OpenClaw ≥ 2026.6 — register a ContextEngine factory (preferred over SDK module import). */
    registerContextEngine?: (id: string, factory: () => unknown) => void;
  };
}

declare module "openclaw/plugin-sdk" {
  /** Fallback for older hosts that export registerContextEngine from the SDK entry. */
  export function registerContextEngine(id: string, factory: () => unknown): void;
}
