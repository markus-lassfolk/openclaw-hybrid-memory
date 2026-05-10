import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { runActiveTaskCheckpoint } from "../services/active-task-checkpoint.js";

function makeConfig(root: string): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    sqlitePath: join(root, "facts.db"),
    lanceDbPath: join(root, "lancedb"),
    activeTask: {
      enabled: true,
      ledger: "facts",
      filePath: "ACTIVE-TASKS.md",
      staleThreshold: "24h",
      projection: {
        mode: "readable",
        excludeGenericTitle: true,
        titleMinChars: 0,
        dedupeBy: "none",
        sectioned: true,
      },
      staleWarning: { enabled: true },
      autoCheckpoint: true,
      flushOnComplete: true,
      injectionBudget: 500,
      taskHygiene: {
        heartbeatEscalation: true,
        suggestGoalAfterTaskAgeDays: 0,
        heartbeatNudgeMaxChars: 2500,
      },
    },
  });
}

function makeEmbeddings(): EmbeddingProvider {
  return {
    modelName: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function makeVectorDb(): VectorDB {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(true),
    store: vi.fn().mockResolvedValue(undefined),
  } as unknown as VectorDB;
}

function latestProjectValue(factsDb: FactsDB, entity: string, key: string): string | undefined {
  const rows = factsDb
    .listFactsByCategory("project", 5000)
    .filter((f) => f.entity === entity && (f.key ?? "") === key)
    .sort((a, b) => b.createdAt - a.createdAt);
  const hit = rows[0];
  if (!hit) return undefined;
  return hit.value ?? hit.text;
}

describe("active-task-checkpoint", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "hm-active-task-checkpoint-"));
    dirs.push(root);
    const cfg = makeConfig(root);
    const factsDb = new FactsDB(cfg.sqlitePath);
    const vectorDb = makeVectorDb();
    const embeddings = makeEmbeddings();
    const openclawDir = join(root, "openclaw");
    return { root, cfg, factsDb, vectorDb, embeddings, openclawDir };
  }

  it("updates project facts and records an episode on success", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    const result = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270",
        status: "in_progress",
        owner: "agent:forge",
        next: "Implement tests",
        relatedSession: "agent:forge:subagent:1",
        title: "Implement checkpoint tool",
        state: { phase: "coding", files: ["a.ts", "b.ts"] },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.steps.facts.ok).toBe(true);
    expect(result.steps.episode.ok).toBe(true);
    expect(result.steps.schedule.attempted).toBe(false);

    expect(latestProjectValue(factsDb, "task-1270", "status")).toBe("in_progress");
    expect(latestProjectValue(factsDb, "task-1270", "next")).toBe("Implement tests");
    expect(latestProjectValue(factsDb, "task-1270", "owner")).toBe("agent:forge");
    expect(latestProjectValue(factsDb, "task-1270", "related_session")).toBe("agent:forge:subagent:1");
    expect(latestProjectValue(factsDb, "task-1270", "title")).toBe("Implement checkpoint tool");
    expect(latestProjectValue(factsDb, "task-1270", "task_updated")).toBeTruthy();
    expect(latestProjectValue(factsDb, "task-1270", "checkpoint_state")).toContain("\"phase\":\"coding\"");

    expect(factsDb.episodesCount()).toBe(1);

    factsDb.close();
  });

  it("returns validation errors for invalid payload", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    const result = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "   ",
        status: "bogus",
        resumeAt: "not-a-date",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.errors.some((e) => e.step === "validation")).toBe(true);
    expect(factsDb.listFactsByCategory("project", 100).length).toBe(0);
    expect(factsDb.episodesCount()).toBe(0);

    factsDb.close();
  });

  it("reports partial failure when wake scheduling fails but keeps checkpoint evidence", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await runActiveTaskCheckpoint(
      {
        cfg,
        factsDb,
        vectorDb,
        embeddings,
        openclawDir,
        scheduleWakeFn: async () => {
          throw new Error("cron store unavailable");
        },
      },
      {
        entity: "task-1270-partial",
        status: "blocked",
        owner: "agent:forge",
        next: "Wait for credentials",
        resumeAt,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.steps.facts.ok).toBe(true);
    expect(result.steps.episode.ok).toBe(true);
    expect(result.steps.schedule.attempted).toBe(true);
    expect(result.steps.schedule.scheduled).toBe(false);
    expect(result.errors.some((e) => e.step === "schedule")).toBe(true);

    expect(latestProjectValue(factsDb, "task-1270-partial", "status")).toBe("blocked");
    expect(latestProjectValue(factsDb, "task-1270-partial", "owner")).toBe("agent:forge");
    expect(factsDb.episodesCount()).toBe(1);

    factsDb.close();
  });

  it("schedules wake reminder when resumeAt is provided", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const resumeAtDate = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const result = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-wake",
        status: "waiting",
        next: "Resume after dependency maintenance",
        resumeAt: resumeAtDate.toISOString(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.steps.schedule.attempted).toBe(true);
    expect(result.steps.schedule.scheduled).toBe(true);
    expect(result.steps.schedule.jobId).toContain("hybrid-mem:active-task-wake:task-1270-wake:");
    expect(result.steps.schedule.jobsPath).toBeTruthy();

    const jobsPath = result.steps.schedule.jobsPath!;
    const raw = readFileSync(jobsPath, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const job = (store.jobs ?? []).find((j) => j.pluginJobId === result.steps.schedule.jobId);
    expect(job).toBeTruthy();
    const schedule = job?.schedule as { kind?: string; expr?: string } | undefined;
    expect(schedule?.kind).toBe("cron");
    expect(schedule?.expr).toBe(result.steps.schedule.cronExpr);

    factsDb.close();
  });
});
