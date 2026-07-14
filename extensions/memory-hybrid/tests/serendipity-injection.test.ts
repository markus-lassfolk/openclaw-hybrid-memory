/**
 * Tests for serendipity policy-summary injection + backlog resurfacing (Issue #2119).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { registerSerendipityPolicyInjection } from "../lifecycle/stage-serendipity-policy.js";
import type { HybridMemoryConfig } from "../config.js";

function buildCfg(sp: Record<string, unknown>): HybridMemoryConfig {
  return parseConfig({
    embedding: { provider: "ollama", model: "nomic-embed-text" },
    serendipityProtocol: sp,
  }) as HybridMemoryConfig;
}

function makeApi() {
  let handler: ((event: unknown, hookCtx: unknown) => Promise<unknown>) | undefined;
  return {
    on(_event: string, h: (event: unknown, hookCtx: unknown) => Promise<unknown>) {
      handler = h;
    },
    fire(event: unknown) {
      if (!handler) throw new Error("no handler registered");
      return handler(event, {});
    },
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    context: {},
  };
}

function makeCtx(store: SerendipityStore | null, cfg: HybridMemoryConfig) {
  return {
    cfg,
    serendipityStore: store,
    currentAgentIdRef: { value: null },
    beforeAgentStartTurnRef: undefined,
    prependBudgetRef: undefined,
  } as any;
}

let tmpDir: string;
let store: SerendipityStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-injection-test-"));
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("serendipity policy injection", () => {
  it("injects a one-line policy summary once per session on a normal turn", async () => {
    const cfg = buildCfg({ enabled: true });
    const api = makeApi();
    registerSerendipityPolicyInjection(api as any, makeCtx(store, cfg));

    const first = (await api.fire({ prompt: "do a thing", sessionKey: "s-policy" })) as { prependContext?: string };
    expect(first?.prependContext).toContain("[serendipity] Level");
    // Once per session: a second normal turn does not re-inject.
    const second = await api.fire({ prompt: "another thing", sessionKey: "s-policy" });
    expect(second).toBeUndefined();
  });

  it("does not register when disabled", () => {
    const cfg = buildCfg({ enabled: false });
    const api = makeApi();
    let registered = false;
    const spyApi = {
      ...api,
      on: () => {
        registered = true;
      },
    };
    registerSerendipityPolicyInjection(spyApi as any, makeCtx(null, cfg));
    expect(registered).toBe(false);
  });
});

describe("serendipity backlog resurfacing", () => {
  it("surfaces the top actionable deferred finding on a heartbeat turn after the cooldown", async () => {
    const cfg = buildCfg({
      enabled: true,
      defaultLevel: 4,
      resurface: { enabled: true, minLevel: 0, cooldownPrompts: 1 },
    });
    store.create({
      title: "apache-arrow missing",
      description: "d",
      findingType: "packaging_defect",
      suggestedAction: "fix_now",
      adjacency: "direct",
    });
    const api = makeApi();
    registerSerendipityPolicyInjection(api as any, makeCtx(store, cfg));

    const res = (await api.fire({ prompt: "heartbeat", sessionKey: "s-hb" })) as { prependContext?: string };
    expect(res?.prependContext).toContain("[serendipity backlog]");
    expect(res?.prependContext).toContain("apache-arrow");
  });

  it("does not resurface below the configured minimum level", async () => {
    const cfg = buildCfg({
      enabled: true,
      defaultLevel: 2,
      injectPolicy: false,
      resurface: { enabled: true, minLevel: 4, cooldownPrompts: 1 },
    });
    store.create({
      title: "x",
      description: "d",
      findingType: "packaging_defect",
      suggestedAction: "fix_now",
    });
    const api = makeApi();
    registerSerendipityPolicyInjection(api as any, makeCtx(store, cfg));
    const res = await api.fire({ prompt: "heartbeat", sessionKey: "s-hb-low" });
    expect(res).toBeUndefined();
  });
});
