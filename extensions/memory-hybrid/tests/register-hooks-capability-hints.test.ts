/**
 * Capability hints injection cadence in registerLifecycleHooks (#1558).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerLifecycleHooks } from "../setup/register-hooks.js";
import { buildPluginApiForRegisterHooks, makeHooksApi } from "./helpers/register-hooks-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

type PromptBuildHookResult = { prependContext?: string } | undefined;

function invokeBeforePromptBuildHandlers(
  api: ReturnType<typeof makeHooksApi>,
  event: Record<string, unknown>,
): PromptBuildHookResult[] {
  const handlers = (api.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === "before_prompt_build")
    .map((c) => c[1] as (ev: unknown, hookCtx: unknown) => PromptBuildHookResult);
  return handlers.map((handler) => handler(event, {}));
}

function findCapabilityHints(results: PromptBuildHookResult[]): string | undefined {
  return results
    .map((r) => r?.prependContext)
    .find((text): text is string => typeof text === "string" && text.includes("memory-hybrid: capability hints"));
}

describe("registerLifecycleHooks capability hints cadence", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "capability-hints-hooks-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects capability hints only once per session by default", () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, { autoRecall: { enabled: true } });
    registerLifecycleHooks(pluginApi as never, api as never);

    const first = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });
    expect(findCapabilityHints(first)).toBeDefined();

    const second = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });
    expect(findCapabilityHints(second)).toBeUndefined();

    const third = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-b" } });
    expect(findCapabilityHints(third)).toBeDefined();
  });

  it("supports opt-in always mode to inject capability hints every prompt", () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, {
      autoRecall: { enabled: true, capabilityHints: "always" },
    });
    registerLifecycleHooks(pluginApi as never, api as never);

    const first = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });
    const second = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });

    expect(findCapabilityHints(first)).toBeDefined();
    expect(findCapabilityHints(second)).toBeDefined();
  });

  it("supports opt-out mode to disable capability hints injection", () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, {
      autoRecall: { enabled: true, capabilityHints: "off" },
    });
    registerLifecycleHooks(pluginApi as never, api as never);

    const first = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });
    const second = invokeBeforePromptBuildHandlers(api, { session: { id: "sess-a" } });

    expect(findCapabilityHints(first)).toBeUndefined();
    expect(findCapabilityHints(second)).toBeUndefined();
  });
});
