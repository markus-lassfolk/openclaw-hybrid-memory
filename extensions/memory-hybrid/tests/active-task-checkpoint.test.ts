import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { runActiveTaskCheckpoint } from "../services/active-task-checkpoint.js";
import * as taskLedgerFacts from "../services/task-ledger-facts.js";

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
  const hit = factsDb.lookup(entity, key, undefined, {
    includeSuperseded: false,
    limit: 1,
  })[0]?.entry;
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
    expect(latestProjectValue(factsDb, "task-1270", "checkpoint_state")).toContain('"phase":"coding"');

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
    expect(result.steps.schedule.jobId).toMatch(/^hybrid-mem:active-task-wake:[a-z0-9-]+:\d+$/);
    expect(result.steps.schedule.scheduleKind).toBe("at");
    expect(result.steps.schedule.scheduleAt).toBe(resumeAtDate.toISOString());
    expect(result.steps.schedule.jobsPath).toBeTruthy();

    const jobsPath = result.steps.schedule.jobsPath as string;
    const raw = readFileSync(jobsPath, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const job = (store.jobs ?? []).find((j) => j.pluginJobId === result.steps.schedule.jobId);
    expect(job).toBeTruthy();
    const schedule = job?.schedule as { kind?: string; at?: string } | undefined;
    expect(schedule?.kind).toBe("at");
    expect(schedule?.at).toBe(result.steps.schedule.scheduleAt);
    const payload = job?.payload as { kind?: string; message?: string } | undefined;
    expect(payload?.kind).toBe("agentTurn");
    expect(String(payload?.message ?? "")).toContain("mkdir -p");

    factsDb.close();
  });

  it("schedules an overdue catch-up wake when resumeAt is already in the past", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const now = new Date("2026-05-10T12:00:00.000Z");
    const overdueResumeAt = "2026-05-10T11:45:00.000Z";

    const result = await runActiveTaskCheckpoint(
      {
        cfg,
        factsDb,
        vectorDb,
        embeddings,
        openclawDir,
        now: () => now,
      },
      {
        entity: "task-1270-overdue-catchup",
        status: "waiting",
        next: "Resume immediately on recovery",
        resumeAt: overdueResumeAt,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.steps.schedule.attempted).toBe(true);
    expect(result.steps.schedule.scheduled).toBe(true);
    expect(result.steps.schedule.scheduleAt).toBe(overdueResumeAt);
    expect(latestProjectValue(factsDb, "task-1270-overdue-catchup", "resume_at")).toBe(overdueResumeAt);

    const jobsPath = result.steps.schedule.jobsPath as string;
    const raw = readFileSync(jobsPath, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const job = (store.jobs ?? []).find((j) => j.pluginJobId === result.steps.schedule.jobId);
    expect(job).toBeTruthy();
    const schedule = job?.schedule as { kind?: string; at?: string } | undefined;
    expect(schedule?.kind).toBe("at");
    expect(schedule?.at).toBe(overdueResumeAt);

    factsDb.close();
  });

  it("disables stale wake reminder when task resumes early and no longer includes resumeAt", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const resumeAtDate = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const first = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-resume-early",
        status: "waiting",
        next: "Resume later",
        resumeAt: resumeAtDate.toISOString(),
      },
    );
    expect(first.ok).toBe(true);
    expect(first.steps.schedule.scheduled).toBe(true);
    expect(first.steps.schedule.jobId).toBeTruthy();

    const second = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-resume-early",
        status: "in_progress",
        next: "Resumed ahead of schedule",
      },
    );
    expect(second.ok).toBe(true);
    expect(second.steps.schedule.attempted).toBe(false);
    expect(second.steps.schedule.scheduled).toBe(false);
    expect(second.steps.schedule.skippedReason).toBe("resumeAt_not_provided");
    expect(second.steps.schedule.disabledPreviousJobs).toBe(1);
    const clearedResumeAt = latestProjectValue(factsDb, "task-1270-resume-early", "resume_at") ?? "";
    expect(clearedResumeAt).not.toContain(resumeAtDate.toISOString());

    const jobsPath = second.steps.schedule.jobsPath;
    expect(jobsPath).toBeTruthy();
    const raw = readFileSync(jobsPath as string, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const wakeJobs = (store.jobs ?? []).filter((j) => {
      const pluginJobId = typeof j.pluginJobId === "string" ? j.pluginJobId : "";
      return pluginJobId.startsWith("hybrid-mem:active-task-wake:");
    });
    expect(wakeJobs.length).toBeGreaterThan(0);
    expect(wakeJobs.filter((j) => j.enabled !== false).length).toBe(0);

    factsDb.close();
  });

  it("disables stale wake reminder when a terminal follow-up checkpoint omits resumeAt", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const resumeAtDate = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const first = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-wake-cleanup",
        status: "waiting",
        next: "Resume later",
        resumeAt: resumeAtDate.toISOString(),
      },
    );
    expect(first.ok).toBe(true);
    expect(first.steps.schedule.scheduled).toBe(true);
    expect(first.steps.schedule.jobId).toBeTruthy();

    const second = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-wake-cleanup",
        status: "done",
      },
    );
    expect(second.ok).toBe(true);
    expect(second.steps.schedule.attempted).toBe(false);
    expect(second.steps.schedule.scheduled).toBe(false);
    expect(second.steps.schedule.skippedReason).toBe("terminal_status_no_wake");
    expect(second.steps.schedule.disabledPreviousJobs).toBe(1);
    const clearedResumeAt = latestProjectValue(factsDb, "task-1270-wake-cleanup", "resume_at") ?? "";
    expect(clearedResumeAt).not.toContain(resumeAtDate.toISOString());

    const jobsPath = second.steps.schedule.jobsPath;
    expect(jobsPath).toBeTruthy();
    const raw = readFileSync(jobsPath as string, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const wakeJobs = (store.jobs ?? []).filter((j) => {
      const pluginJobId = typeof j.pluginJobId === "string" ? j.pluginJobId : "";
      return pluginJobId.startsWith("hybrid-mem:active-task-wake:");
    });
    expect(wakeJobs.length).toBeGreaterThan(0);
    expect(wakeJobs.filter((j) => j.enabled !== false).length).toBe(0);

    factsDb.close();
  });

  it("does not schedule a wake when terminal status includes resumeAt and clears stale wake metadata", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const firstResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const staleResumeAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    const first = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-terminal-stale-wake",
        status: "waiting",
        next: "Resume later",
        resumeAt: firstResumeAt.toISOString(),
      },
    );
    expect(first.ok).toBe(true);
    expect(first.steps.schedule.scheduled).toBe(true);

    const second = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-terminal-stale-wake",
        status: "done",
        resumeAt: staleResumeAt,
      },
    );

    expect(second.ok).toBe(true);
    expect(second.steps.schedule.attempted).toBe(false);
    expect(second.steps.schedule.scheduled).toBe(false);
    expect(second.steps.schedule.skippedReason).toBe("terminal_status_no_wake");
    expect(second.steps.schedule.disabledPreviousJobs).toBe(1);
    const clearedResumeAt = latestProjectValue(factsDb, "task-1270-terminal-stale-wake", "resume_at") ?? "";
    expect(clearedResumeAt).not.toContain(firstResumeAt.toISOString());
    expect(clearedResumeAt).not.toContain(staleResumeAt);

    const jobsPath = second.steps.schedule.jobsPath;
    expect(jobsPath).toBeTruthy();
    const raw = readFileSync(jobsPath as string, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const wakeJobs = (store.jobs ?? []).filter((j) => {
      const pluginJobId = typeof j.pluginJobId === "string" ? j.pluginJobId : "";
      return pluginJobId.startsWith("hybrid-mem:active-task-wake:");
    });
    expect(wakeJobs.length).toBeGreaterThan(0);
    expect(wakeJobs.filter((j) => j.enabled !== false).length).toBe(0);

    factsDb.close();
  });

  it("preserves existing status/owner/next/related_session when optional fields are omitted", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    const baseline = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-preserve",
        status: "blocked",
        owner: "agent:forge",
        next: "Wait for dependency",
        relatedSession: "agent:main:session-a",
      },
    );
    expect(baseline.ok).toBe(true);

    const followup = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-preserve",
        title: "Updated title only",
        scheduleWake: false,
      },
    );
    expect(followup.ok).toBe(true);
    expect(followup.checkpoint?.status).toBe("blocked");
    expect(followup.checkpoint?.owner).toBe("agent:forge");
    expect(followup.checkpoint?.next).toBe("Wait for dependency");
    expect(followup.checkpoint?.relatedSession).toBe("agent:main:session-a");
    expect(followup.steps.facts.updatedKeys).toEqual(
      expect.arrayContaining(["status", "owner", "next", "related_session"]),
    );

    factsDb.close();
  });

  it("preserves omitted fields even when task facts are older than the newest 8k project rows", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    const baseline = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-old-preserve",
        status: "blocked",
        owner: "agent:forge",
        next: "Wait for dependency",
        relatedSession: "agent:main:session-a",
      },
    );
    expect(baseline.ok).toBe(true);

    for (let i = 0; i < 8105; i++) {
      factsDb.store({
        text: `Noise task status ${i}`,
        category: "project",
        importance: 0.2,
        entity: `noise-${i}`,
        key: "status",
        value: "in_progress",
        source: "conversation",
      });
    }

    const followup = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-old-preserve",
        title: "Updated title only",
        scheduleWake: false,
      },
    );

    expect(followup.ok).toBe(true);
    expect(followup.checkpoint?.status).toBe("blocked");
    expect(followup.checkpoint?.owner).toBe("agent:forge");
    expect(followup.checkpoint?.next).toBe("Wait for dependency");
    expect(followup.checkpoint?.relatedSession).toBe("agent:main:session-a");

    factsDb.close();
  }, 45_000);

  it("preserves explicitly cleared owner/next fields on follow-up checkpoints", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    const baseline = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-clear-fields",
        status: "in_progress",
        owner: "agent:forge",
        next: "Initial next step",
      },
    );
    expect(baseline.ok).toBe(true);

    const clearFields = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-clear-fields",
        owner: "",
        next: "",
      },
    );
    expect(clearFields.ok).toBe(true);
    expect(clearFields.checkpoint?.owner).toBe("");
    expect(clearFields.checkpoint?.next).toBe("");

    const followup = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-clear-fields",
        title: "Touch checkpoint",
      },
    );
    expect(followup.ok).toBe(true);
    expect(followup.checkpoint?.owner).toBe("");
    expect(followup.checkpoint?.next).toBe("");

    factsDb.close();
  });

  it("preserves terminal statuses from existing facts when status is omitted", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    factsDb.store({
      text: "Task task-1270-terminal status: superseded",
      category: "project",
      importance: 0.3,
      entity: "task-1270-terminal",
      key: "status",
      value: "superseded",
      source: "conversation",
    });
    factsDb.store({
      text: "Task task-1270-terminal-abandoned status: abandoned",
      category: "project",
      importance: 0.3,
      entity: "task-1270-terminal-abandoned",
      key: "status",
      value: "abandoned",
      source: "conversation",
    });

    const result = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-terminal",
        title: "Metadata only checkpoint",
        scheduleWake: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.checkpoint?.status).toBe("superseded");
    expect(latestProjectValue(factsDb, "task-1270-terminal", "status")).toBe("superseded");

    const abandonedResult = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-terminal-abandoned",
        title: "Metadata only checkpoint",
        scheduleWake: false,
      },
    );
    expect(abandonedResult.ok).toBe(true);
    expect(abandonedResult.checkpoint?.status).toBe("abandoned");
    expect(latestProjectValue(factsDb, "task-1270-terminal-abandoned", "status")).toBe("abandoned");

    factsDb.close();
  });

  it("preserves abandoned status from existing facts when status is omitted", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();

    factsDb.store({
      text: "Task task-1270-abandoned status: abandoned",
      category: "project",
      importance: 0.3,
      entity: "task-1270-abandoned",
      key: "status",
      value: "abandoned",
      source: "conversation",
    });

    const result = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: "task-1270-abandoned",
        title: "Metadata only checkpoint",
        scheduleWake: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.checkpoint?.status).toBe("abandoned");
    expect(latestProjectValue(factsDb, "task-1270-abandoned", "status")).toBe("abandoned");

    factsDb.close();
  });

  it("keeps wake jobs isolated for long similar entity names", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const base = "task-with-a-very-long-entity-name-that-shares-a-prefix-between-two-different-items-";
    const resumeA = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const resumeB = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    const first = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: `${base}alpha`,
        status: "waiting",
        next: "resume alpha",
        resumeAt: resumeA,
      },
    );
    const second = await runActiveTaskCheckpoint(
      { cfg, factsDb, vectorDb, embeddings, openclawDir },
      {
        entity: `${base}beta`,
        status: "waiting",
        next: "resume beta",
        resumeAt: resumeB,
      },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.steps.schedule.disabledPreviousJobs).toBe(0);

    const jobsPath = second.steps.schedule.jobsPath as string;
    const raw = readFileSync(jobsPath, "utf-8");
    const store = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    const activeWakeJobs = (store.jobs ?? []).filter(
      (j) => typeof j.pluginJobId === "string" && j.pluginJobId.startsWith("hybrid-mem:active-task-wake:"),
    );
    expect(activeWakeJobs.filter((j) => j.enabled !== false).length).toBeGreaterThanOrEqual(2);

    factsDb.close();
  });

  it("skips wake scheduling when fact writes fail", async () => {
    const { cfg, factsDb, vectorDb, embeddings, openclawDir } = setup();
    const spy = vi.spyOn(taskLedgerFacts, "upsertProjectTaskKey").mockRejectedValue(new Error("write failed"));
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    try {
      const result = await runActiveTaskCheckpoint(
        { cfg, factsDb, vectorDb, embeddings, openclawDir },
        {
          entity: "task-1270-fail-facts",
          status: "waiting",
          next: "recheck",
          resumeAt,
        },
      );
      expect(result.steps.facts.ok).toBe(false);
      expect(result.steps.schedule.attempted).toBe(false);
      expect(result.steps.schedule.skippedReason).toBe("facts_write_failed");
    } finally {
      spy.mockRestore();
      factsDb.close();
    }
  });
});
