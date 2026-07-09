/**
 * Regression test (loop iteration 129) for setup/register-tools.ts:
 *
 * `registerTools`'s installer loop (`for (const installer of toolInstallers) { installer.install(...); }`)
 * had no per-installer try/catch. `createGenerationGuardedToolsApi` accumulates a dispose list of
 * every successfully-registered tool, but that list is only reachable via the `handle` object
 * returned at the very end of `registerTools` -- if any installer partway through the list threw,
 * `registerTools` itself threw before `return handle`, discarding the disposer list for every tool
 * already registered by earlier installers. The caller (`register-plugin.ts`) never receives a
 * handle in that case, so those already-registered tools stayed permanently live in the host's
 * tool registry with no way to unregister them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHybridMemoryRegistrationStateForTests } from "../setup/hybrid-memory-generation-state.js";
import type { ToolsContext } from "../setup/tool-installers.js";

type FakeToolInstaller = {
  selectContext: (ctx: unknown) => unknown;
  install: (ctx: unknown, toolsApi: { registerTool: (tool: unknown, options?: unknown) => unknown }) => void;
};

const { toolInstallersMock } = vi.hoisted(() => ({ toolInstallersMock: { current: [] as FakeToolInstaller[] } }));

vi.mock("../setup/tool-installers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/tool-installers.js")>();
  return {
    ...actual,
    get toolInstallers() {
      return toolInstallersMock.current;
    },
  };
});

describe("registerTools disposes already-registered tools when a later installer throws (loop iteration 129 regression)", () => {
  beforeEach(() => {
    resetHybridMemoryRegistrationStateForTests();
  });

  afterEach(() => {
    resetHybridMemoryRegistrationStateForTests();
    vi.resetModules();
  });

  it("disposes tools registered by earlier installers before rethrowing", async () => {
    const disposedToolNames: string[] = [];
    const registerTool = vi.fn((tool: { name: string }) => {
      // Simulate a host API that returns an unregister function, as the guarded-tool-api
      // dispose path expects (collectUnregister accepts a bare function result).
      return () => disposedToolNames.push(tool.name);
    });
    const api = { registerTool, logger: { debug: vi.fn(), warn: vi.fn() } };

    const goodInstaller: FakeToolInstaller = {
      selectContext: (ctx) => ctx,
      install: (_ctx, toolsApi) => {
        toolsApi.registerTool({ name: "tool_one", execute: async () => ({}) }, {});
      },
    };
    const throwingInstaller: FakeToolInstaller = {
      selectContext: (ctx) => ctx,
      install: () => {
        throw new Error("simulated installer failure (loop iteration 129 regression)");
      },
    };
    toolInstallersMock.current = [goodInstaller, throwingInstaller];

    const { registerTools } = await import("../setup/register-tools.js");
    const ctx = {
      registrationGeneration: 1,
      currentRegistrationGenerationRef: { value: 1 },
    } as unknown as ToolsContext;

    expect(() => registerTools(ctx, api as never)).toThrow(/simulated installer failure/);
    expect(disposedToolNames).toEqual(["tool_one"]);
  });

  it("still returns a working handle when every installer succeeds", async () => {
    const registerTool = vi.fn(() => () => {});
    const api = { registerTool, logger: { debug: vi.fn(), warn: vi.fn() } };

    const installerA: FakeToolInstaller = {
      selectContext: (ctx) => ctx,
      install: (_ctx, toolsApi) => {
        toolsApi.registerTool({ name: "tool_a", execute: async () => ({}) }, {});
      },
    };
    const installerB: FakeToolInstaller = {
      selectContext: (ctx) => ctx,
      install: (_ctx, toolsApi) => {
        toolsApi.registerTool({ name: "tool_b", execute: async () => ({}) }, {});
      },
    };
    toolInstallersMock.current = [installerA, installerB];

    const { registerTools } = await import("../setup/register-tools.js");
    const ctx = {
      registrationGeneration: 1,
      currentRegistrationGenerationRef: { value: 1 },
    } as unknown as ToolsContext;

    const handle = registerTools(ctx, api as never);
    expect(handle).toBeDefined();
    expect(registerTool).toHaveBeenCalledTimes(2);
  });
});
