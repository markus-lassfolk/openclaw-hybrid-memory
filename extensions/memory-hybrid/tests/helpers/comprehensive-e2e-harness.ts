/**
 * Harness for full plugin register() end-to-end tests (real DB bootstrap + api.on hooks).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Mock } from "vitest";
import { vi } from "vitest";
import memoryHybridPlugin from "../../index.js";

export const E2E_EMBEDDING_DIM = 1536;

/** Raw plugin config for register() — parsed once inside register (avoid mode=custom re-parse). */
export function getFullStackConfig(tmpDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "local",
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    sqlitePath: join(tmpDir, "facts.db"),
    lanceDbPath: join(tmpDir, "lancedb"),
    errorReporting: { enabled: false, consent: false },
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: false },
    verification: { enabled: false },
    provenance: { enabled: false },
    sensorSweep: { enabled: false },
    autoClassify: { enabled: false },
    languageKeywords: { autoBuild: false },
    passiveObserver: { enabled: false },
    documents: { enabled: false },
    goalStewardship: { enabled: false },
    workflowTracking: { enabled: false },
    frustrationDetection: { enabled: false },
    autoRecall: {
      enabled: true,
      authFailure: { enabled: false },
      limit: 5,
      injectionFormat: "full",
    },
    activeTask: { enabled: false, ledger: "facts" },
    store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    ...overrides,
  };
}

export type FullStackApi = ReturnType<typeof makeFullStackApi>;

export function makeFullStackApi(tmpDir: string): {
  on: Mock;
  registerTool: (opts: Record<string, unknown>, options?: unknown) => void;
  getTool: (name: string) => { execute: (...args: unknown[]) => unknown } | undefined;
  registerService: Mock;
  registerCli: Mock;
  registerLifecycleHook: Mock;
  registerHttpRoute: Mock;
  logger: { info: Mock; warn: Mock; debug: Mock; error: Mock };
  context: { sessionId: string; sessionKey: string; agentId: string };
  config: Record<string, unknown>;
  resolvePath: (p: string) => string;
  pluginConfig: Record<string, unknown> | undefined;
  registrationMode: "full";
  version: string;
  startService: () => Promise<void>;
  stopService: () => Promise<void>;
  registeredEvents: () => string[];
  hookHandlers: (eventName: string) => Array<(event: unknown, hookCtx: unknown) => Promise<unknown>>;
} {
  let registeredService: {
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
  } | null = null;
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();

  const api = {
    on: vi.fn(),
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    registerService: vi.fn((svc: typeof registeredService) => {
      registeredService = svc;
    }),
    registerCli: vi.fn(),
    registerLifecycleHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "e2e-session", sessionKey: "agent:main:telegram:e2e", agentId: "main" },
    config: {},
    resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    pluginConfig: undefined as Record<string, unknown> | undefined,
    registrationMode: "full" as const,
    version: "2026.5.0",
    async startService() {
      await registeredService?.start?.();
    },
    async stopService() {
      await registeredService?.stop?.();
    },
    registeredEvents(): string[] {
      return (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    },
    hookHandlers(eventName: string): Array<(event: unknown, hookCtx: unknown) => Promise<unknown>> {
      return (api.on as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === eventName).map((c) => c[1]);
    },
  };

  return api;
}

export function registerFullPlugin(api: FullStackApi, pluginConfig: Record<string, unknown>): void {
  api.pluginConfig = pluginConfig;
  memoryHybridPlugin.register(api as never);
}

export async function invokeHooks(
  api: FullStackApi,
  eventName: string,
  event: unknown,
  hookCtx: unknown,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of api.hookHandlers(eventName)) {
    results.push(await handler(event, hookCtx));
  }
  return results;
}

export function assertFullStackPaths(tmpDir: string): void {
  expect(existsSync(join(tmpDir, "facts.db"))).toBe(true);
}
