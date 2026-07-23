import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHybridMemoryRegistrationState,
  resetHybridMemoryRegistrationStateForTests,
} from "../setup/hybrid-memory-generation-state.js";
import { createGenerationGuardedToolsApi } from "../setup/register-tools.js";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => unknown;
};

function makeRegisterToolApi(registerToolImpl?: (tool: RegisteredTool, options?: unknown) => unknown): {
  api: {
    registerTool: (tool: RegisteredTool, options?: unknown) => unknown;
    logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  };
  tools: RegisteredTool[];
} {
  const tools: RegisteredTool[] = [];
  const registerTool = vi.fn((tool: RegisteredTool, options?: unknown) => {
    tools.push(tool);
    if (registerToolImpl) return registerToolImpl(tool, options);
    return undefined;
  });
  return {
    api: {
      registerTool,
      logger: { debug: vi.fn(), warn: vi.fn() },
    },
    tools,
  };
}

describe("tool registration generation guard", () => {
  beforeEach(() => {
    resetHybridMemoryRegistrationStateForTests();
  });

  afterEach(() => {
    resetHybridMemoryRegistrationStateForTests();
  });

  it("delegates stale memory_recall and active_task_checkpoint executors to current generation", async () => {
    const state = getHybridMemoryRegistrationState();
    const { api, tools } = makeRegisterToolApi();

    state.registrationGenerationRef.value = 1;
    const oldRecallExecute = vi.fn(async () => {
      throw new Error("The database connection is not open");
    });
    const oldCheckpointExecute = vi.fn(async () => {
      throw new Error("The database connection is not open");
    });

    const oldRegistration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 1,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      api as never,
    );
    oldRegistration.api.registerTool({ name: "memory_recall", execute: oldRecallExecute } as never, {
      name: "memory_recall",
    });
    oldRegistration.api.registerTool({ name: "active_task_checkpoint", execute: oldCheckpointExecute } as never, {
      name: "active_task_checkpoint",
    });

    const staleRecallExecute = tools.find((tool) => tool.name === "memory_recall")?.execute;
    const staleCheckpointExecute = tools.find((tool) => tool.name === "active_task_checkpoint")?.execute;
    expect(staleRecallExecute).toBeTypeOf("function");
    expect(staleCheckpointExecute).toBeTypeOf("function");

    state.registrationGenerationRef.value = 2;
    const newRecallResult = { content: [{ type: "text", text: "new recall generation" }] };
    const newCheckpointResult = { content: [{ type: "text", text: "new checkpoint generation" }] };
    const newRecallExecute = vi.fn(async () => newRecallResult);
    const newCheckpointExecute = vi.fn(async () => newCheckpointResult);

    const newRegistration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 2,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      api as never,
    );
    newRegistration.api.registerTool({ name: "memory_recall", execute: newRecallExecute } as never, {
      name: "memory_recall",
    });
    newRegistration.api.registerTool({ name: "active_task_checkpoint", execute: newCheckpointExecute } as never, {
      name: "active_task_checkpoint",
    });

    await expect(staleRecallExecute?.("old-call", {})).resolves.toEqual(newRecallResult);
    await expect(staleCheckpointExecute?.("old-call", {})).resolves.toEqual(newCheckpointResult);
    expect(oldRecallExecute).not.toHaveBeenCalled();
    expect(oldCheckpointExecute).not.toHaveBeenCalled();
    expect(newRecallExecute).toHaveBeenCalledTimes(1);
    expect(newCheckpointExecute).toHaveBeenCalledTimes(1);
  });

  it("returns safe stale result when delegation target is unavailable", async () => {
    const state = getHybridMemoryRegistrationState();
    const { api, tools } = makeRegisterToolApi();

    state.registrationGenerationRef.value = 1;
    const oldExecute = vi.fn(async () => {
      throw new Error("The database connection is not open");
    });

    const registration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 1,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      api as never,
    );
    registration.api.registerTool({ name: "memory_recall", execute: oldExecute } as never, { name: "memory_recall" });

    const staleExecute = tools.find((tool) => tool.name === "memory_recall")?.execute;
    expect(staleExecute).toBeTypeOf("function");

    state.registrationGenerationRef.value = 2;
    const result = await staleExecute?.("old-call", {});
    expect(oldExecute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: [{ type: "text" }],
      details: {
        staleRegistration: true,
        delegated: false,
        skipped: true,
        tool: "memory_recall",
        registrationGeneration: 1,
        currentGeneration: 2,
      },
    });
  });

  it("disposes unregister handles returned by registerTool and clears generation executors", () => {
    const state = getHybridMemoryRegistrationState();
    const disposeFn = vi.fn();
    const unregisterFn = vi.fn();
    const { api } = makeRegisterToolApi((_tool, options) => {
      const name = (options as { name?: string } | undefined)?.name;
      if (name === "memory_recall") return disposeFn;
      if (name === "active_task_checkpoint") return { dispose: disposeFn };
      if (name === "memory_store") return { unregister: unregisterFn };
      return undefined;
    });

    state.registrationGenerationRef.value = 3;
    const registration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 3,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      api as never,
    );
    registration.api.registerTool({ name: "memory_recall", execute: vi.fn() } as never, { name: "memory_recall" });
    registration.api.registerTool({ name: "active_task_checkpoint", execute: vi.fn() } as never, {
      name: "active_task_checkpoint",
    });
    registration.api.registerTool({ name: "memory_store", execute: vi.fn() } as never, { name: "memory_store" });
    expect(getHybridMemoryRegistrationState().toolExecutorsByName.size).toBeGreaterThan(0);

    registration.handle.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(2);
    expect(unregisterFn).toHaveBeenCalledTimes(1);
    expect(getHybridMemoryRegistrationState().toolExecutorsByName.size).toBe(0);

    registration.handle.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(2);
    expect(unregisterFn).toHaveBeenCalledTimes(1);
  });

  it("disposes unregister handles returned by registerHttpRoute", () => {
    const state = getHybridMemoryRegistrationState();
    const disposeRoute = vi.fn();
    const registerHttpRoute = vi.fn(() => ({ dispose: disposeRoute }));
    const { api } = makeRegisterToolApi();
    const apiWithRoutes = {
      ...api,
      registerHttpRoute,
    };

    state.registrationGenerationRef.value = 4;
    const registration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 4,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      apiWithRoutes as never,
    );

    registration.api.registerHttpRoute?.({ path: "/plugins/memory-public/export" } as never);
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);

    registration.handle.dispose();
    expect(disposeRoute).toHaveBeenCalledTimes(1);

    registration.handle.dispose();
    expect(disposeRoute).toHaveBeenCalledTimes(1);
  });

  it("returns initializing safe result while activation is in progress for the current generation", async () => {
    const { beginActivation, markActivationReady, resetActivationStateForTests } = await import(
      "../setup/hybrid-memory-activation.js"
    );
    const { setLiveToolExecutor, clearLiveToolExecutorsForGeneration } = await import("../setup/register-tools.js");
    resetActivationStateForTests();

    const state = getHybridMemoryRegistrationState();
    const { api, tools } = makeRegisterToolApi();
    state.registrationGenerationRef.value = 10;
    beginActivation({ generation: 10, donorGeneration: 9 });

    const registration = createGenerationGuardedToolsApi(
      {
        registrationGeneration: 10,
        currentRegistrationGenerationRef: state.registrationGenerationRef,
      },
      api as never,
    );
    const liveExecute = vi.fn(async () => ({ content: [{ type: "text", text: "live" }], details: { ok: true } }));
    registration.api.registerTool({
      name: "memory_recall",
      execute: async () => ({ content: [{ type: "text", text: "stub" }], details: { ok: false } }),
    } as never);

    const result = (await tools[0]!.execute()) as { details?: { initializing?: boolean } };
    expect(result.details?.initializing).toBe(true);
    expect(liveExecute).not.toHaveBeenCalled();

    setLiveToolExecutor(10, "memory_recall", liveExecute);
    markActivationReady(10);
    const live = (await tools[0]!.execute()) as { details?: { ok?: boolean; initializing?: boolean } };
    expect(live.details?.initializing).not.toBe(true);
    expect(liveExecute).toHaveBeenCalledTimes(1);

    clearLiveToolExecutorsForGeneration(10);
    registration.handle.dispose();
    resetActivationStateForTests();
  });

  it("keeps generation state on globalThis across module reload", async () => {
    vi.resetModules();
    const moduleA = await import("../setup/hybrid-memory-generation-state.js");
    moduleA.resetHybridMemoryRegistrationStateForTests();
    moduleA.getHybridMemoryRegistrationState().registrationGenerationRef.value = 41;

    vi.resetModules();
    const moduleB = await import("../setup/hybrid-memory-generation-state.js");
    expect(moduleB.getHybridMemoryRegistrationState().registrationGenerationRef.value).toBe(41);
    moduleB.resetHybridMemoryRegistrationStateForTests();
  });
});
