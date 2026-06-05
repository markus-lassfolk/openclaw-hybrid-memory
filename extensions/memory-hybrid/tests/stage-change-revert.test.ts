/**
 * registerChangeRevertHandler before_agent_start wiring.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { registerChangeRevertHandler } from "../lifecycle/stage-change-revert.js";
import { ChangeFeed } from "../services/change-feed.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { setEnv } from "../utils/env-manager.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

const { FactsDB } = _testing;

const SESSION_KEY = "agent:main:telegram:change-revert";

describe("registerChangeRevertHandler", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let proposalsDb: ProposalsDB;
  let changeFeed: ChangeFeed;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage-change-revert-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");

    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    changeFeed = new ChangeFeed(factsDb);
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureHandler(cfgOverrides: Record<string, unknown> = {}) {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      liveChangeFeed: {
        enabled: true,
        notifyInChat: true,
        notifyOn: {
          sessionAdaptation: true,
          proposalCreated: true,
          proposalApplied: true,
          proposalReverted: false,
          dreamCycleComplete: false,
        },
      },
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
      ...cfgOverrides,
    });
    ctx.changeFeed = changeFeed;
    ctx.proposalsDb = proposalsDb;
    ctx.resolvedSqlitePath = join(tmpDir, "facts.db");

    const api = makeMockStageApi(SESSION_KEY);
    const sessionState = makeRecallSessionState(ctx);
    registerChangeRevertHandler(api as never, ctx, sessionState);
    const reg = (api.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "before_agent_start");
    return {
      handler: reg?.[1] as (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>,
      sessionState,
    };
  }

  it("ignores messages without revert change phrasing", async () => {
    const { handler } = captureHandler();
    const out = await handler(
      { prompt: "undo the last persona edit please" },
      { sessionKey: SESSION_KEY, sessionId: SESSION_KEY },
    );
    expect(out).toBeUndefined();
  });

  it("reverts a display-numbered change via user message and prepends result", async () => {
    const original = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(tmpDir, "SOUL.md"), applied, "utf-8");

    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Applied",
      observation: "obs",
      suggestedChange: "Applied guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    proposalsDb.updateStatusIf(proposal.id, "approved", "pending");
    proposalsDb.markAppliedIfApproved(proposal.id);
    writeProposalRollback(join(tmpDir, "facts.db"), {
      proposalId: proposal.id,
      proposalType: "persona",
      targetPath: join(tmpDir, "SOUL.md"),
      originalHash: createHash("sha256").update(original).digest("hex"),
      originalContent: original,
      appliedHash: createHash("sha256").update(applied).digest("hex"),
      appliedAt: new Date().toISOString(),
    });

    const key = makeUnifiedKey("persona", proposal.id);
    const appliedEvent = changeFeed.append({
      sessionKey: SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Applied persona proposal",
      detail: "Applied to SOUL.md",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-reload",
    });

    const { handler, sessionState } = captureHandler();
    sessionState.displayRevertMap.set(SESSION_KEY, new Map([[1, appliedEvent.id]]));

    const out = await handler(
      { prompt: "Actually revert change 1 — that was too aggressive." },
      { sessionKey: SESSION_KEY, sessionId: SESSION_KEY },
    );

    expect(out?.prependContext).toContain("<memory-change-revert>");
    expect(out?.prependContext).toContain("Reverted change #1");
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toBe(original);
    expect(changeFeed.getById(appliedEvent.id)?.status).toBe("reverted");
  });

  it("prepends an error block when revert fails", async () => {
    const { handler, sessionState } = captureHandler();
    sessionState.displayRevertMap.set(SESSION_KEY, new Map([[9, "missing-event-id"]]));

    const out = await handler(
      { messages: [{ role: "user", content: "revert change #9" }] },
      { sessionKey: SESSION_KEY, sessionId: SESSION_KEY },
    );

    expect(out?.prependContext).toContain('<memory-change-revert error="true">');
    expect(out?.prependContext).toContain("Could not revert change #9");
  });

  it("does not register when live change feed is disabled", () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      liveChangeFeed: { enabled: false },
    });
    ctx.changeFeed = changeFeed;
    const api = makeMockStageApi(SESSION_KEY);
    registerChangeRevertHandler(api as never, ctx, makeRecallSessionState(ctx));
    expect((api.on as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
