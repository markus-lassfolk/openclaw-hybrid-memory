/**
 * Lifecycle agent_end + pre-finalization guard integration (Node >= 22.16).
 * Exercises hooks.ts guard path with real FactsDB (#1479, #1486, #1271).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { TASK_LEDGER_CATEGORY } from "../services/task-ledger-facts.js";
import { runActiveTaskCheckpoint } from "../services/active-task-checkpoint.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { VectorDB } from "../backends/vector-db.js";
import {
  benignFinalizationMessages,
  MAIN_CANONICAL_SESSION,
  MAIN_TELEGRAM_SESSION,
  pendingCiTurnMessages,
  seedForgeActiveTask,
  seedMainTelegramCheckpoint,
} from "./fixtures/maeve-ledger.js";
import {
  buildGuardTestLifecycleContext,
  captureAgentEndHandler,
  invokeAgentEnd,
} from "./helpers/lifecycle-hook-harness.js";

describe("lifecycle agent_end pre-finalization guard", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-agent-end-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows agent_end when turn has no external-work signals", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(
      invokeAgentEnd(handler, api, benignFinalizationMessages(), MAIN_TELEGRAM_SESSION),
    ).resolves.toBeUndefined();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("allows agent_end when CI pending but FactsDB ledger is empty (#1479)", async () => {
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("warns on agent_end when CI pending and session-owned ledger lacks checkpoint fields", async () => {
    const entity = "issue-telegram-incomplete";
    factsDb.store({
      text: `Task [${entity}] status: in_progress`,
      category: TASK_LEDGER_CATEGORY,
      importance: 0.7,
      entity,
      key: "status",
      value: "in_progress",
      source: "test",
      decayClass: "permanent",
    });
    factsDb.store({
      text: `Task [${entity}] related_session: ${MAIN_TELEGRAM_SESSION}`,
      category: TASK_LEDGER_CATEGORY,
      importance: 0.7,
      entity,
      key: "related_session",
      value: MAIN_TELEGRAM_SESSION,
      source: "test",
      decayClass: "permanent",
    });
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("pre-finalization guard"));
  });

  it("does not block main Telegram session when only Forge subagent rows exist in FactsDB (#1479)", async () => {
    seedForgeActiveTask(factsDb);
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
  });

  it("allows agent_end when main task checkpoint uses agent:main:main but sessionKey is agent:main:telegram (#1486)", async () => {
    seedMainTelegramCheckpoint(factsDb, {
      relatedSession: MAIN_CANONICAL_SESSION,
      updatedIso: new Date().toISOString(),
    });
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("warns on agent_end when canonical agent:main:main ledger row is incomplete for telegram session (#1486)", async () => {
    const entity = "issue-telegram-canonical-incomplete";
    factsDb.store({
      text: `Task [${entity}] status: waiting`,
      category: TASK_LEDGER_CATEGORY,
      importance: 0.7,
      entity,
      key: "status",
      value: "waiting",
      source: "test",
      decayClass: "permanent",
    });
    factsDb.store({
      text: `Task [${entity}] related_session: ${MAIN_CANONICAL_SESSION}`,
      category: TASK_LEDGER_CATEGORY,
      importance: 0.7,
      entity,
      key: "related_session",
      value: MAIN_CANONICAL_SESSION,
      source: "test",
      decayClass: "permanent",
    });
    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("pre-finalization guard"));
  });

  it("allows agent_end after active_task_checkpoint with live session key then pending CI language (#1486 chain)", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      activeTask: {
        enabled: true,
        ledger: "facts",
        filePath: "ACTIVE-TASKS.md",
        staleThreshold: "24h",
      },
    });
    const vectorDb = {
      hasDuplicate: vi.fn().mockResolvedValue(true),
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "text-embedding-3-small",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    } as unknown as EmbeddingProvider;

    const checkpoint = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir: join(tmpDir, "openclaw") },
      {
        entity: "issue-checkpoint-chain",
        status: "waiting",
        next: "Recheck CI.",
        relatedSession: MAIN_TELEGRAM_SESSION,
        title: "CI watch",
      },
    );
    expect(checkpoint.ok).toBe(true);

    const ctx = buildGuardTestLifecycleContext(tmpDir, factsDb);
    const { handler, api } = captureAgentEndHandler(ctx, MAIN_TELEGRAM_SESSION);

    await expect(invokeAgentEnd(handler, api, pendingCiTurnMessages(), MAIN_TELEGRAM_SESSION)).resolves.toBeUndefined();
  });
});
