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
import { AGENT_TOOL_CONTRACT_NAMES } from "../contracts/agent-tool-names.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  clearToolExecutorsForGeneration,
  resolveCurrentToolExecutor,
  setCurrentToolExecutor,
} from "./hybrid-memory-generation-state.js";
import { shouldReturnInitializingToolResult, isActivationFailed, isActivationReady, getActivationFailureError } from "./hybrid-memory-activation.js";
import { patchMemoryToolRegistrationApi } from "../utils/tool-search-wrapper-args.js";
import { type ToolsContext, toolInstallers } from "./tool-installers.js";

export interface ToolRegistrationHandle {
  dispose: () => void;
}

/** Live (post-activation) tool bodies for a registration generation (#2181 two-phase). */
const liveToolExecutorsByGeneration = new Map<number, Map<string, (...args: unknown[]) => unknown>>();

export function setLiveToolExecutor(
  generation: number,
  toolName: string,
  execute: (...args: unknown[]) => unknown,
): void {
  let byName = liveToolExecutorsByGeneration.get(generation);
  if (!byName) {
    byName = new Map();
    liveToolExecutorsByGeneration.set(generation, byName);
  }
  byName.set(toolName, execute);
}

export function clearLiveToolExecutorsForGeneration(generation: number): void {
  liveToolExecutorsByGeneration.delete(generation);
}

function resolveLiveToolExecutor(toolName: string, generation: number): ((...args: unknown[]) => unknown) | null {
  return liveToolExecutorsByGeneration.get(generation)?.get(toolName) ?? null;
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

/** Deterministic safe result while Phase B activation is still opening/attaching DBs (#2181). */
export function buildInitializingToolSafeResult(
  toolName: string,
  ownerGeneration: number,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [
      {
        type: "text",
        text:
          `memory-hybrid: reloading — tool "${toolName}" is temporarily unavailable ` +
          `(generation ${ownerGeneration} still activating; retry shortly)`,
      },
    ],
    details: {
      ok: false,
      initializing: true,
      reloading: true,
      skipped: true,
      tool: toolName,
      registrationGeneration: ownerGeneration,
      activationPhase: "activating",
    },
  };
}

/** Fail-closed result when Phase B activation failed — never pretend we are still initializing. */
export function buildActivationFailedToolSafeResult(
  toolName: string,
  ownerGeneration: number,
  error: string | null,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const detail = error?.trim() ? error.trim() : "deferred activation failed";
  return {
    content: [
      {
        type: "text",
        text:
          `memory-hybrid: activation failed — tool "${toolName}" is unavailable ` +
          `(generation ${ownerGeneration}: ${detail}). Re-register or restart the gateway.`,
      },
    ],
    details: {
      ok: false,
      initializing: false,
      activationFailed: true,
      reloading: false,
      skipped: true,
      tool: toolName,
      registrationGeneration: ownerGeneration,
      activationPhase: "failed",
      error: detail,
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
  const baseRegisterHttpRoute =
    typeof api.registerHttpRoute === "function"
      ? (api.registerHttpRoute.bind(api) as (...args: unknown[]) => unknown)
      : undefined;
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
        // Two-phase activation (#2181): current-generation stubs wait for Phase B before
        // invoking the live body (or the original execute when registration was fully sync).
        const live = resolveLiveToolExecutor(toolName, ownerGeneration);
        if (live) return live(...executeArgs);
        if (shouldReturnInitializingToolResult(ownerGeneration)) {
          return buildInitializingToolSafeResult(toolName, ownerGeneration);
        }
        // Phase B failed: never fall through to the Phase A stub that always returns "initializing".
        if (isActivationFailed(ownerGeneration)) {
          return buildActivationFailedToolSafeResult(
            toolName,
            ownerGeneration,
            getActivationFailureError(ownerGeneration),
          );
        }
        // Two-phase ready but live body never bound — fail closed.
        if (isActivationReady(ownerGeneration)) {
          return buildActivationFailedToolSafeResult(
            toolName,
            ownerGeneration,
            "tool executor not bound after activation",
          );
        }
        // Sync registerTools / no activation state for this generation: use the registered body.
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

  const guardedRegisterHttpRoute = (...args: unknown[]): unknown => {
    if (!baseRegisterHttpRoute) return undefined;
    const registrationResult = baseRegisterHttpRoute(...args);
    collectUnregister(disposeCandidates, registrationResult);
    return registrationResult;
  };

  const guardedApi = {
    ...api,
    registerTool: guardedRegisterTool as ClawdbotPluginApi["registerTool"],
    ...(baseRegisterHttpRoute
      ? { registerHttpRoute: guardedRegisterHttpRoute as ClawdbotPluginApi["registerHttpRoute"] }
      : {}),
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
        clearLiveToolExecutorsForGeneration(ownerGeneration);
      },
    },
  };
}

/**
 * Phase A (#2181): publish host-visible tool stubs for every contract name so sync `register()`
 * satisfies the gateway contract while Phase B opens databases. Stub execute bodies return the
 * initializing safe result until {@link bindActivatedToolExecutors} installs live handlers.
 */
export function registerActivationToolStubs(
  ctx: Pick<ToolsContext, "registrationGeneration" | "currentRegistrationGenerationRef">,
  api: ClawdbotPluginApi,
): ToolRegistrationHandle {
  const { api: guardedApi, handle } = createGenerationGuardedToolsApi(ctx, api);
  const toolsApi = patchMemoryToolRegistrationApi(guardedApi);
  const ownerGeneration = ctx.registrationGeneration ?? ctx.currentRegistrationGenerationRef?.value ?? -1;

  for (const toolName of AGENT_TOOL_CONTRACT_NAMES) {
    toolsApi.registerTool({
      name: toolName,
      description: `memory-hybrid: ${toolName} (activating)`,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        if (isActivationFailed(ownerGeneration)) {
          return buildActivationFailedToolSafeResult(
            toolName,
            ownerGeneration,
            getActivationFailureError(ownerGeneration),
          );
        }
        return buildInitializingToolSafeResult(toolName, ownerGeneration);
      },
    } as never);
  }
  return handle;
}

/**
 * Phase B (#2181): install real tool bodies into the live-executor map without re-calling the
 * host's `registerTool` (stubs already occupy those names from Phase A).
 */
export function bindActivatedToolExecutors(ctx: ToolsContext, api: ClawdbotPluginApi): void {
  const ownerGeneration = ctx.registrationGeneration ?? ctx.currentRegistrationGenerationRef?.value ?? -1;
  const captureRegisterTool = (...args: unknown[]): unknown => {
    const [definition] = args as [{ name?: unknown; execute?: unknown } | undefined];
    const toolName = normalizeToolName(definition);
    if (!definition || typeof definition.execute !== "function" || !toolName) return undefined;
    setLiveToolExecutor(ownerGeneration, toolName, definition.execute as (...a: unknown[]) => unknown);
    // Keep generation-guard delegation pointing at the stub's guarded execute (already set in
    // Phase A). Live bodies are resolved via liveToolExecutorsByGeneration.
    return undefined;
  };

  const captureApi = {
    ...api,
    registerTool: captureRegisterTool as ClawdbotPluginApi["registerTool"],
  } as ClawdbotPluginApi;
  const toolsApi = patchMemoryToolRegistrationApi(captureApi);
  for (const installer of toolInstallers) {
    installer.install(installer.selectContext(ctx, toolsApi), toolsApi);
  }
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
  const toolsApi = patchMemoryToolRegistrationApi(guardedApi);
  try {
    for (const installer of toolInstallers) {
      installer.install(installer.selectContext(ctx, toolsApi), toolsApi);
    }
  } catch (err) {
    // An installer partway through the list can throw (e.g. a tool name missing from
    // openclaw.plugin.json#contracts.tools). Every installer before it already registered its
    // tools with the host and is tracked in `handle`'s dispose list -- but since this function
    // is about to throw instead of returning `handle`, the caller can never reach
    // handle.dispose() to unregister them. Dispose internally before rethrowing so nothing
    // already-registered stays permanently live in the host's tool registry.
    handle.dispose();
    throw err;
  }
  return handle;
}
