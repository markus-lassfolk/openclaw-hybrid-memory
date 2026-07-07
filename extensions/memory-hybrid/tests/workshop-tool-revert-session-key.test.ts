/**
 * memory_workshop's revert_by_ordinal action accepted a caller-supplied `sessionKey` param and
 * used it directly (via resolveWorkshopRevertSessionKey) without ever checking it against the
 * caller's own trusted session -- the same class of cross-session IDOR already fixed for the
 * change-feed HTTP/RPC revert routes (proposal-routes.ts, proposal-gateway-methods.ts) via
 * isAuthorizedChangeFeedSessionKey. This test proves the tool-call surface is now guarded too.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { ChangeFeed } from "../services/change-feed.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { registerWorkshopTools } from "../tools/workshop-tool.js";

const { FactsDB } = _testing;

function makeMockApi(sessionKey: string) {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    callTool(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionKey },
  };
}

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let proposalsDb: ProposalsDB;
let changeFeed: ChangeFeed;
let cfg: HybridMemoryConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "workshop-tool-revert-"));
  writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
  changeFeed = new ChangeFeed(factsDb);
  cfg = {
    liveChangeFeed: { enabled: true },
    personaProposals: {
      enabled: true,
      autoApply: false,
      allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md"],
      maxProposalsPerWeek: 50,
      minConfidence: 0.5,
      proposalTTLDays: 30,
      minSessionEvidence: 1,
      requireScopeFilter: false,
      separateSelfCorrectionQuota: true,
    },
  } as HybridMemoryConfig;
});

afterEach(() => {
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a real persona proposal + matching change-feed "proposed" entry, revertible end-to-end. */
function seedRevertibleProposal(sessionKey: string) {
  const proposal = proposalsDb.create({
    targetFile: "SOUL.md",
    title: "Test persona proposal",
    observation: "obs",
    suggestedChange: "New content",
    confidence: 0.9,
    evidenceSessions: [sessionKey],
  });
  const event = changeFeed.append({
    sessionKey,
    timestamp: Date.now(),
    tier: "persistent",
    category: "persona",
    action: "proposed",
    title: proposal.title,
    detail: "",
    proposalKey: makeUnifiedKey("persona", proposal.id),
    rollbackAvailable: true,
    activation: "next-reload",
  });
  return { proposal, event };
}

describe("memory_workshop revert_by_ordinal session-key authorization (loop iteration 60)", () => {
  it("rejects an explicit sessionKey override that does not match the caller's own trusted session, even though the revert would otherwise succeed", async () => {
    const { proposal, event } = seedRevertibleProposal("victim-session");

    const api = makeMockApi("attacker-session");
    registerWorkshopTools(
      { cfg, factsDb, proposalsDb, resolvedSqlitePath: join(tmpDir, "facts.db"), changeFeed },
      api as unknown as ClawdbotPluginApi,
    );

    const result = (await api.callTool("memory_workshop", {
      action: "revert_by_ordinal",
      ordinal: event.ordinal,
      sessionKey: "victim-session",
    })) as { content: Array<{ text: string }>; details: { ok: boolean } };

    expect(result.details.ok).toBe(false);
    expect(result.content[0]?.text).toMatch(/sessionKey does not match/);
    expect(changeFeed.getById(event.id)?.status).toBe("active");
    expect(proposalsDb.get(proposal.id)?.status).toBe("pending");
  });

  it("still allows reverting the caller's own session's change when no sessionKey override is given", async () => {
    const { proposal, event } = seedRevertibleProposal("chat-1");

    const api = makeMockApi("chat-1");
    registerWorkshopTools(
      { cfg, factsDb, proposalsDb, resolvedSqlitePath: join(tmpDir, "facts.db"), changeFeed },
      api as unknown as ClawdbotPluginApi,
    );

    const result = (await api.callTool("memory_workshop", {
      action: "revert_by_ordinal",
      ordinal: event.ordinal,
    })) as { details: { ok: boolean; error?: string } };

    expect(result.details.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("rejected");
  });
});
