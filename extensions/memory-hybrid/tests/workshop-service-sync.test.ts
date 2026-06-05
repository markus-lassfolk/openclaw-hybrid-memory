import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { ChangeFeed } from "../services/change-feed.js";
import { BROADCAST_CHANGE_SESSION_KEY } from "../services/change-feed-emit.js";
import { syncWorkshopProposedEvents, withWorkshopDefaults } from "../services/workshop-service.js";
import { setEnv } from "../utils/env-manager.js";

const { FactsDB } = _testing;

describe("syncWorkshopProposedEvents", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let proposalsDb: ProposalsDB;
  let changeFeed: ChangeFeed;
  let cfg: HybridMemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workshop-sync-"));
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    changeFeed = new ChangeFeed(factsDb);
    cfg = {
      personaProposals: {
        enabled: true,
        autoApply: false,
        allowedFiles: ["SOUL.md"],
        maxProposalsPerWeek: 50,
        minConfidence: 0.5,
        proposalTTLDays: 30,
        minSessionEvidence: 1,
        requireScopeFilter: false,
        separateSelfCorrectionQuota: true,
      },
      liveChangeFeed: { enabled: true },
    } as HybridMemoryConfig;
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backfills missing persona proposed events for pending backlog", () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Backfill persona",
      observation: "obs",
      suggestedChange: "Add guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });

    const ctx = withWorkshopDefaults({
      cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed,
    });

    expect(syncWorkshopProposedEvents(ctx)).toBe(1);
    const events = changeFeed.listRecent({ sessionKey: BROADCAST_CHANGE_SESSION_KEY, limit: 10 });
    expect(events.some((e) => e.proposalKey === `persona:${proposal.id}` && e.action === "proposed")).toBe(true);

    expect(syncWorkshopProposedEvents(ctx)).toBe(0);
  });
});
