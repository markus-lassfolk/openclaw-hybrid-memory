// @ts-nocheck
/**
 * Regression test (#2067-followup) for tools/utility-tools.ts's memory_checkpoint tool:
 *
 * saveCheckpoint()/restoreCheckpoint() stored and read the checkpoint fact with no scope/
 * scopeTarget at all -- it always landed in (and was read back from) the single implicit
 * "global" slot regardless of which tenant saved it. Any caller's `restore` returned whichever
 * tenant's checkpoint was saved most recently, potentially leaking another tenant's `intent`/
 * `state`/`workingFiles` verbatim. The sibling active_task_checkpoint tool already threads scope
 * through for exactly this reason; memory_checkpoint now does too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerUtilityTools } from "../tools/utility-tools.js";

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
  };
}

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-checkpoint-scope-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function setup(currentAgentId: string) {
  const cfg = hybridConfigSchema.parse({ embedding: { provider: "onnx", model: "bge-m3", dimensions: 1024 } });
  const api = makeMockApi();
  const currentAgentIdRef = { value: currentAgentId };
  registerUtilityTools(
    {
      factsDb,
      vectorDb: {} as never,
      embeddings: {} as never,
      openai: {} as never,
      cfg,
      wal: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      currentAgentIdRef,
      buildToolScopeFilter: (_params: unknown, currentAgent: string | null) =>
        currentAgent ? { agentId: currentAgent } : undefined,
    },
    api as never,
    async () => ({ metaExtracted: 0, metaStored: 0 }),
    async () => ({ rulesExtracted: 0, rulesStored: 0 }),
    async () => ({ metaExtracted: 0, metaStored: 0 }),
    async () => null,
    async () => {},
  );
  return { api, currentAgentIdRef };
}

describe("memory_checkpoint scope leak (#2067-followup)", () => {
  it("tenant B's restore does not return tenant A's checkpoint", async () => {
    const { api: apiA } = setup("tenantA");
    await apiA.getTool("memory_checkpoint")?.execute("call-1", {
      action: "save",
      intent: "Tenant A: about to rotate prod DB creds",
      state: "mid-rotation, old key still valid",
      workingFiles: ["/secrets/prod.env"],
    });

    const { api: apiB } = setup("tenantB");
    const result = (await apiB.getTool("memory_checkpoint")?.execute("call-2", { action: "restore" })) as {
      details: { action: string };
    };

    expect(result.details.action).toBe("not_found");
  });

  it("a tenant can restore its own checkpoint", async () => {
    const { api } = setup("tenantA");
    await api.getTool("memory_checkpoint")?.execute("call-1", {
      action: "save",
      intent: "Tenant A's own task",
      state: "in progress",
    });

    const result = (await api.getTool("memory_checkpoint")?.execute("call-2", { action: "restore" })) as {
      details: { action: string; checkpoint?: { intent: string } };
    };

    expect(result.details.action).toBe("restored");
    expect(result.details.checkpoint?.intent).toBe("Tenant A's own task");
  });
});
