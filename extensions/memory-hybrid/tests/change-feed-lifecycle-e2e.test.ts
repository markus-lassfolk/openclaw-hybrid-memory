/**
 * End-to-end: change notice → display revert map → NL revert → file restored.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import { _testing } from "../index.js";
import { registerChangeNotifyHandler } from "../lifecycle/stage-change-notify.js";
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

const SESSION_KEY = "agent:main:telegram:change-e2e";

describe("change feed lifecycle e2e", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let proposalsDb: ProposalsDB;
  let changeFeed: ChangeFeed;
  let originalWorkspace: string | undefined;
  let notifyHandler: (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>;
  let revertHandler: (event: unknown, hookCtx: unknown) => Promise<{ prependContext?: string } | undefined>;
  let sessionState: ReturnType<typeof makeRecallSessionState>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "change-feed-e2e-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");

    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    changeFeed = new ChangeFeed(factsDb);

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
        maxInChatEventsPerTurn: 5,
        inChatBudgetTokens: 500,
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
    });
    ctx.changeFeed = changeFeed;
    ctx.proposalsDb = proposalsDb;
    ctx.resolvedSqlitePath = join(tmpDir, "facts.db");

    const api = makeMockStageApi(SESSION_KEY);
    sessionState = makeRecallSessionState(ctx);
    registerChangeNotifyHandler(api as never, ctx, sessionState);
    registerChangeRevertHandler(api as never, ctx, sessionState);

    const handlers = (api.on as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "before_agent_start");
    notifyHandler = handlers[0]![1] as typeof notifyHandler;
    revertHandler = handlers[1]![1] as typeof revertHandler;
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("notifies about an applied change then reverts it via display number and restores the file", async () => {
    const original = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(tmpDir, "SOUL.md"), applied, "utf-8");

    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Tone adjustment",
      observation: "User prefers concise replies.",
      suggestedChange: "Applied guidance.",
      confidence: 0.9,
      evidenceSessions: [SESSION_KEY],
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

    changeFeed.append({
      sessionKey: SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Persona applied: Tone adjustment",
      detail: "Applied to SOUL.md",
      proposalKey: makeUnifiedKey("persona", proposal.id),
      rollbackAvailable: true,
      activation: "next-reload",
    });

    const hookCtx = { sessionKey: SESSION_KEY, sessionId: SESSION_KEY };
    const notice = await notifyHandler({ prompt: "What should I work on next?" }, hookCtx);
    expect(notice?.prependContext).toContain("<memory-change-notice>");
    expect(notice?.prependContext).toContain("#1 [session/persistent]");
    expect(notice?.prependContext).toContain('revert change 1');

    const revertMap = sessionState.displayRevertMap.get(SESSION_KEY);
    expect(revertMap?.get(1)).toBeDefined();

    const revert = await revertHandler({ prompt: "revert change 1" }, hookCtx);
    expect(revert?.prependContext).toContain("<memory-change-revert>");
    expect(revert?.prependContext).toContain("Reverted change #1");
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toBe(original);
    expect(proposalsDb.get(proposal.id)?.status).toBe("pending");
  });
});
