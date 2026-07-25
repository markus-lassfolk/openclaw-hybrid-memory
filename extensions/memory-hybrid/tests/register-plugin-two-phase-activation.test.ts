/**
 * Regression for #2181: sync register() must not block on Promise-chain teardown via Atomics.wait.
 *
 * Full-teardown re-register enters two-phase activation:
 *   Phase A — sync: schedule teardown, publish tool stubs, return immediately
 *   Phase B — async: await donor teardown (event-loop friendly), open DBs, bind live tools
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitActivationReady,
  getActivationState,
  resetPluginRegistrationStateForTests,
  runtimeRef,
} from "../setup/register-plugin.js";
import { resetReloadTeardownChainForTests, schedulePluginTeardown } from "../setup/hybrid-memory-reload-coordinator.js";
import {
  type FullStackApi,
  getFullStackConfig,
  makeFullStackApi,
  registerFullPlugin,
} from "./helpers/comprehensive-e2e-harness.js";

describe("two-phase reload activation (#2181)", () => {
  let tmpDir: string;
  let api: FullStackApi;
  let originalPolicy: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "two-phase-activation-"));
    api = makeFullStackApi(tmpDir);
    resetPluginRegistrationStateForTests();
    originalPolicy = process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
    // Force full teardown so re-register takes the deferred-activation path.
    process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "full";
  });

  afterEach(() => {
    resetPluginRegistrationStateForTests();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalPolicy === undefined) delete process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY;
    else process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = originalPolicy;
  });

  it("re-register returns quickly even when donor teardown is still pending", async () => {
    const cfg = () => getFullStackConfig(tmpDir);
    registerFullPlugin(api, cfg());
    expect(runtimeRef.value).not.toBeNull();
    const firstGen = runtimeRef.value!.bootRegistrationGeneration!;

    // Simulate a stuck prior teardown that would previously starve under Atomics.wait.
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    schedulePluginTeardown(
      async () => {
        await blocker;
      },
      { donorGeneration: firstGen },
    );

    const started = Date.now();
    registerFullPlugin(api, cfg());
    const syncMs = Date.now() - started;

    // Must not burn the old ~8s Atomics.wait budget.
    expect(syncMs).toBeLessThan(1500);

    const activation = getActivationState();
    expect(activation?.phase).toBe("activating");
    expect(activation?.generation).toBeGreaterThan(firstGen);

    const recall = api.getTool("memory_recall");
    expect(recall).toBeDefined();
    const initializing = (await recall!.execute("t1", { query: "ping" })) as {
      details?: { initializing?: boolean; reloading?: boolean };
    };
    expect(initializing.details?.initializing).toBe(true);

    release();
    const ready = await awaitActivationReady(activation!.generation, 20_000);
    expect(ready).toBe(true);
    expect(getActivationState()?.phase).toBe("ready");
    expect(runtimeRef.value?.bootRegistrationGeneration).toBe(activation!.generation);

    const after = (await recall!.execute("t2", { query: "ping" })) as {
      details?: { initializing?: boolean };
    };
    expect(after.details?.initializing).not.toBe(true);
  });

  it("activates generation 2 with omitted DB paths without passing undefined to resolvePath", async () => {
    const legacyDreaming = JSON.parse(
      readFileSync(join(process.cwd(), "tests", "fixtures", "legacy-dreaming-config.json"), "utf8"),
    ) as Record<string, unknown>;
    const resolvePath = vi.fn((path: string) => {
      if (typeof path !== "string") throw new TypeError('The "path" argument must be of type string.');
      return path;
    });
    api.resolvePath = resolvePath;

    registerFullPlugin(api, getFullStackConfig(tmpDir, legacyDreaming));
    const firstGeneration = runtimeRef.value!.bootRegistrationGeneration!;
    const deferredConfig = getFullStackConfig(tmpDir, legacyDreaming);
    delete deferredConfig.sqlitePath;
    delete deferredConfig.lanceDbPath;

    registerFullPlugin(api, deferredConfig);
    const activation = getActivationState();
    expect(activation?.generation).toBeGreaterThan(firstGeneration);
    expect(await awaitActivationReady(activation!.generation, 20_000)).toBe(true);
    expect(runtimeRef.value?.bootRegistrationGeneration).toBe(activation!.generation);
    expect(resolvePath).toHaveBeenCalled();
    expect(resolvePath.mock.calls.flat().every((path) => typeof path === "string")).toBe(true);

    // The legacy dreaming migration is parsed independently and remains intact across the handoff.
    expect(runtimeRef.value?.cfg.dreaming.compose).toEqual(["distill", "reflect", "consolidate"]);
    expect(runtimeRef.value?.cfg.nightlyCycle.schedule).toBe("15 3 * * *");
    expect(runtimeRef.value?.cfg.nightlyCycle.model).toBe("azure-foundry/gpt-4.1-mini");
    expect(getActivationState()?.phase).toBe("ready");
  });

  it("never throws 'reload teardown did not drain before opening new databases'", async () => {
    const cfg = () => getFullStackConfig(tmpDir);
    registerFullPlugin(api, cfg());

    // Leave a never-resolving teardown on the donor generation; Phase B must still recover.
    schedulePluginTeardown(
      async () => {
        await new Promise(() => {
          /* never */
        });
      },
      { donorGeneration: runtimeRef.value!.bootRegistrationGeneration! },
    );

    expect(() => registerFullPlugin(api, cfg())).not.toThrow();
    const activation = getActivationState();
    expect(activation?.phase).toBe("activating");

    // Phase B opens fresh after the bounded async wait — must become ready, not fail register.
    const ready = await awaitActivationReady(activation!.generation, 20_000);
    expect(ready).toBe(true);
    resetReloadTeardownChainForTests();
  });
});
