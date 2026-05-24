/**
 * Tool Registration Wiring
 *
 * Registers all plugin tools with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 *
 * OpenClaw 2026.5+ requires `openclaw.plugin.json#contracts.tools` to list every
 * tool name before `registerTool` succeeds — keep in sync with
 * `contracts/agent-tool-names.ts`.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import {
  clearToolExecutorsForGeneration,
  resolveCurrentToolExecutor,
  setCurrentToolExecutor,
} from "./hybrid-memory-generation-state.js";
import { type ToolsContext, toolInstallers } from "./tool-installers.js";

export interface ToolRegistrationHandle {
  dispose: () => void;
}

function normalizeToolName(definition: unknown): string | null {
  if (!definition || typeof definition !== "object") return null;
  const name = (definition as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const normalized = name.trim();
  return normalized.length > 0 ? normalized : null;
}

function collectUnregister(disposeCandidates: Array<() => void>, registrationResult: unknown): void {
  if (typeof registrationResult === "function") {
    disposeCandidates.push(registrationResult as () => void);
    return;
  }
  if (!registrationResult || typeof registrationResult !== "object") return;
  if (typeof (registrationResult as { dispose?: unknown }).dispose === "function") {
    disposeCandidates.push(() => (registrationResult as { dispose: () => void }).dispose());
    return;
  }
  if (typeof (registrationResult as { unregister?: unknown }).unregister === "function") {
    disposeCandidates.push(() => (registrationResult as { unregister: () => void }).unregister());
  }
}

function buildStaleToolSafeResult(
  toolName: string,
  ownerGeneration: number,
  currentGeneration: number,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [
      {
        type: "text",
        text:
          `memory-hybrid: skipped stale tool registration for "${toolName}" ` +
          `(generation ${ownerGeneration}, current ${currentGeneration})`,
      },
    ],
    details: {
      ok: false,
      staleRegistration: true,
      delegated: false,
      skipped: true,
      tool: toolName,
      registrationGeneration: ownerGeneration,
      currentGeneration,
    },
  };
}

export function createGenerationGuardedToolsApi(
  ctx: Pick<ToolsContext, "registrationGeneration" | "currentRegistrationGenerationRef">,
  api: ClawdbotPluginApi,
): { api: ClawdbotPluginApi; handle: ToolRegistrationHandle } {
  const ownerGeneration = ctx.registrationGeneration ?? ctx.currentRegistrationGenerationRef?.value ?? -1;
  const generationRef = ctx.currentRegistrationGenerationRef ?? { value: ownerGeneration };
  const baseRegisterTool = api.registerTool.bind(api) as (...args: unknown[]) => unknown;
  const disposeCandidates: Array<() => void> = [];
  let disposed = false;

  const guardedRegisterTool = (...args: unknown[]): unknown => {
    const [definition, options] = args as [{ execute?: unknown } | undefined, unknown];
    const toolName = normalizeToolName(definition);
    if (!definition || typeof definition !== "object" || typeof definition.execute !== "function" || !toolName) {
      const registrationResult = baseRegisterTool(...args);
      collectUnregister(disposeCandidates, registrationResult);
      return registrationResult;
    }

    const originalExecute = definition.execute as (...executeArgs: unknown[]) => unknown;
    const guardedExecute = (...executeArgs: unknown[]): unknown => {
      const currentGeneration = generationRef.value;
      if (currentGeneration === ownerGeneration) {
        return originalExecute(...executeArgs);
      }

      const delegatedExecute = resolveCurrentToolExecutor(toolName, currentGeneration);
      if (delegatedExecute) {
        api.logger.debug?.(
          `memory-hybrid: stale tool "${toolName}" generation ${ownerGeneration} delegated to ${currentGeneration}`,
        );
        return delegatedExecute(...executeArgs);
      }

      api.logger.warn?.(
        `memory-hybrid: stale tool "${toolName}" generation ${ownerGeneration} has no delegate for current generation ${currentGeneration}; skipping`,
      );
      return buildStaleToolSafeResult(toolName, ownerGeneration, currentGeneration);
    };

    const guardedDefinition = { ...definition, execute: guardedExecute };
    const registrationResult = baseRegisterTool(guardedDefinition, options);
    setCurrentToolExecutor(toolName, ownerGeneration, guardedExecute);
    collectUnregister(disposeCandidates, registrationResult);
    return registrationResult;
  };

  const guardedApi = {
    ...api,
    registerTool: guardedRegisterTool as ClawdbotPluginApi["registerTool"],
  } as ClawdbotPluginApi;

  return {
    api: guardedApi,
    handle: {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const pendingDisposers = [...disposeCandidates];
        disposeCandidates.length = 0;
        for (const dispose of pendingDisposers) {
          try {
            dispose();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "registration",
              operation: "register-tools:dispose-tool",
              severity: "warning",
            });
          }
        }
        clearToolExecutorsForGeneration(ownerGeneration);
      },
    },
  };
}

/** Tool registration receives the stable plugin API (Phase 3). */
/**
 * Register all plugin tools with the OpenClaw API.
 * Calls tool registration modules in the correct order.
 *
 * Tool `name` strings must satisfy provider schemas (e.g. Anthropic:
 * `^[a-zA-Z0-9_-]{1,128}$` — letters, digits, underscore, hyphen only; no dots).
 */
export function registerTools(ctx: ToolsContext, api: ClawdbotPluginApi): ToolRegistrationHandle {
  const { api: guardedApi, handle } = createGenerationGuardedToolsApi(ctx, api);
  for (const installer of toolInstallers) {
    installer.install(installer.selectContext(ctx, guardedApi), guardedApi);
  }
  return handle;
}
