import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerHybridMemCliWithApi, type HybridMemCliRegistrationContext } from "../setup/cli-context.js";
import { setEnv } from "../utils/env-manager.js";

function makeCfg(goalsDir: string) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    goalStewardship: {
      enabled: true,
      goalsDir,
      heartbeatPatterns: ["^cron heartbeat"],
      heartbeatStewardship: true,
      watchdogHealthCheck: true,
    },
  });
}

function makeCliRegistrationContext(workspace: string): HybridMemCliRegistrationContext {
  const stub = {} as unknown;
  return {
    factsDb: stub as HybridMemCliRegistrationContext["factsDb"],
    vectorDb: stub as HybridMemCliRegistrationContext["vectorDb"],
    embeddings: stub as HybridMemCliRegistrationContext["embeddings"],
    openai: stub as HybridMemCliRegistrationContext["openai"],
    cfg: makeCfg("state/goals-test"),
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    proposalsDb: null,
    identityReflectionStore: null,
    personaStateStore: null,
    verificationStore: null,
    provenanceService: null,
    resolvedSqlitePath: join(workspace, "memory", "facts.db"),
    resolvedLancePath: join(workspace, "memory", "lancedb"),
    pluginId: "openclaw-hybrid-memory",
    detectCategory: (() => "fact") as HybridMemCliRegistrationContext["detectCategory"],
    eventLog: null,
    costTracker: null,
    eventBus: null,
    auditStore: null,
    agentHealthStore: null,
  };
}

function makeMockApi(registerCapture: { callback: ((opts: { program: Command }) => void) | null }): ClawdbotPluginApi {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolvePath: (p: string) => p,
    registerCli: (callback: (opts: { program: Command }) => void) => {
      registerCapture.callback = callback;
    },
  } as unknown as ClawdbotPluginApi;
}

async function expectCommandCompletesAndRunsTeardown(argv: string[]): Promise<void> {
  const prevWorkspace = process.env.OPENCLAW_WORKSPACE;
  const workspace = mkdtempSync(join(tmpdir(), "hm-cli-teardown-"));
  setEnv("OPENCLAW_WORKSPACE", workspace);

  // Sentinel handle: if teardown is skipped this interval keeps ticking.
  let ticks = 0;
  const sentinel = setInterval(() => {
    ticks += 1;
  }, 75);

  const onComplete = vi.fn(async () => {
    clearInterval(sentinel);
  });

  const capture: { callback: ((opts: { program: Command }) => void) | null } = {
    callback: null,
  };
  const api = makeMockApi(capture);
  const ctx = makeCliRegistrationContext(workspace);
  registerHybridMemCliWithApi(api, ctx, { onHybridMemCliComplete: onComplete });
  expect(capture.callback).not.toBeNull();

  const program = new Command("openclaw");
  program.exitOverride();
  capture.callback?.({ program });

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    await program.parseAsync(argv, { from: "user" });
    const ticksAfterCompletion = ticks;
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(ticks).toBe(ticksAfterCompletion);
    expect(stdoutSpy).toHaveBeenCalled();
  } finally {
    clearInterval(sentinel);
    stdoutSpy.mockRestore();
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("hybrid-mem CLI teardown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs completion teardown for goals list --json so one-shot CLI does not hang", async () => {
    await expectCommandCompletesAndRunsTeardown(["hybrid-mem", "goals", "list", "--json"]);
  });
});
