import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import { collectDreamCycleLog, collectWorkshopChanges, collectWorkshopProposals } from "../routes/dashboard/workshop-collectors.js";
import { ChangeFeed } from "../services/change-feed.js";
import { BROADCAST_CHANGE_SESSION_KEY } from "../services/change-feed-emit.js";

describe("collectDreamCycleLog", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads stage artifacts from run-* subdirectories", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-log-"));
    const runDir = join(tmpDir, "run-20260605T120000Z");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "stage-01-prune.json"),
      JSON.stringify({ runId: "20260605T120000Z", stageNumber: 1, stage: "prune", status: "complete" }),
    );
    writeFileSync(
      join(runDir, "stage-02-reflection.json"),
      JSON.stringify({ runId: "20260605T120000Z", stageNumber: 2, stage: "reflection", status: "complete" }),
    );

    const runs = collectDreamCycleLog(
      {
        cfg: {} as HybridMemoryConfig,
        factsDb: {} as never,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
        dreamCycleLogDir: tmpDir,
      },
      5,
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("20260605T120000Z");
    expect(runs[0]?.stages).toHaveLength(2);
    expect(runs[0]?.stages?.[0]?.stageNumber).toBe(1);
    expect(runs[0]?.stages?.[1]?.stageNumber).toBe(2);
  });
});

describe("collectWorkshopProposals", () => {
  it("excludes applied persona without rollback metadata from undoable list", () => {
    const proposals = collectWorkshopProposals({
      cfg: { personaProposals: { enabled: true } } as HybridMemoryConfig,
      factsDb: { getProceduresReadyForSkill: () => [] } as never,
      proposalsDb: {
        list: (filters?: { status?: string }) => {
          if (filters?.status === "pending") {
            return [{ id: "p1", title: "Pending", status: "pending", confidence: 0.7, createdAt: 50, targetFile: "SOUL.md", observation: "", suggestedChange: "" }];
          }
          if (filters?.status === "applied") {
            return [{ id: "p2", title: "Applied", status: "applied", confidence: 0.9, createdAt: 100, targetFile: "USER.md", observation: "", suggestedChange: "" }];
          }
          return [];
        },
      } as never,
      resolvedSqlitePath: "/tmp/facts.db",
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe("p1");
  });
});

describe("collectWorkshopChanges", () => {
  it("returns broadcast change feed events when enabled", () => {
    const db = new DatabaseSync(":memory:");
    const changeFeed = ChangeFeed.fromDb(db);
    changeFeed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Dashboard visible change",
      detail: "",
      proposalKey: "persona:dash",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    const changes = collectWorkshopChanges(
      {
        cfg: { liveChangeFeed: { enabled: true } } as HybridMemoryConfig,
        factsDb: {} as never,
        resolvedSqlitePath: "/tmp/facts.db",
        changeFeed,
      },
      10,
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.title).toBe("Dashboard visible change");
  });
});
