// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { PROPOSAL_API_PREFIX, CHANGE_FEED_API_PREFIX, registerProposalHttpRoutes } from "../tools/proposal-routes.js";
import { ChangeFeed } from "../services/change-feed.js";
import { setEnv } from "../utils/env-manager.js";

const { FactsDB } = _testing;

const { capturedRoutes } = vi.hoisted(() => {
  const routes: Array<{
    path: string;
    handler: (req: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  }> = [];
  return { capturedRoutes: routes };
});

vi.mock("../tools/safe-register-http-route.js", () => ({
  createSafeRegisterHttpRoute: () => (path: string, handler: (typeof capturedRoutes)[number]["handler"]) => {
    capturedRoutes.push({ path, handler });
  },
}));

async function invokeRoute(
  suffix: string,
  opts?: { method?: string; body?: Record<string, unknown>; query?: Record<string, string> },
) {
  const route = capturedRoutes.find((r) => r.path === `${PROPOSAL_API_PREFIX}${suffix}`);
  expect(route).toBeDefined();
  const params = new URLSearchParams(opts?.query ?? {});
  const url = params.size > 0 ? `${PROPOSAL_API_PREFIX}${suffix}?${params}` : `${PROPOSAL_API_PREFIX}${suffix}`;
  const response = await route!.handler({
    method: opts?.method ?? "POST",
    url,
    headers: { "Content-Type": "application/json" },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: response.status, json: JSON.parse(response.body) };
}

describe("registerProposalHttpRoutes", () => {
  let tmpDir: string;
  let proposalsDb: ProposalsDB;
  let factsDb: InstanceType<typeof FactsDB>;
  let cfg: HybridMemoryConfig;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    capturedRoutes.length = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-routes-"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", tmpDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "# SOUL\nInitial.\n", "utf-8");
    proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    cfg = {
      health: { enabled: true, authenticated: true },
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
      procedures: { enabled: false },
      crystallization: { enabled: false },
      selfExtension: { enabled: false },
    } as HybridMemoryConfig;

    registerProposalHttpRoutes({
      cfg: { health: cfg.health },
      cfgFull: cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed: null,
      api: {
        registerHttpRoute: () => {},
        logger: { warn: () => {}, info: () => {} },
      } as unknown as ClawdbotPluginApi,
    });
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers workshop routes when workshop is enabled", () => {
    expect(capturedRoutes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        `${PROPOSAL_API_PREFIX}/list`,
        `${PROPOSAL_API_PREFIX}/reject`,
        `${PROPOSAL_API_PREFIX}/undo`,
      ]),
    );
  });

  it("registers workshop routes even when health.enabled is false", () => {
    capturedRoutes.length = 0;
    const disabledHealthCfg = {
      ...cfg,
      health: { enabled: false, authenticated: true },
    } as HybridMemoryConfig;
    registerProposalHttpRoutes({
      cfg: { health: disabledHealthCfg.health },
      cfgFull: disabledHealthCfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed: null,
      api: {
        registerHttpRoute: (path: string) => {
          capturedRoutes.push({ path, handler: async () => ({}) });
        },
        logger: { warn: () => {}, info: () => {} },
      } as unknown as ClawdbotPluginApi,
    });
    expect(capturedRoutes.map((r) => r.path)).toContain(`${PROPOSAL_API_PREFIX}/list`);
  });

  it("reject route rejects a pending persona proposal via JSON body", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Test",
      observation: "obs",
      suggestedChange: "Add guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);

    const result = await invokeRoute("/reject", { body: { id: key, reason: "not now" } });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("rejected");
    expect(proposalsDb.get(proposal.id)?.rejectionReason).toBe("not now");
  });

  it("approve route applies a pending persona proposal via JSON body", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Apply me",
      observation: "obs",
      suggestedChange: "Prefer concise replies.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);

    const result = await invokeRoute("/approve", { body: { id: key } });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("applied");
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toContain("Prefer concise replies.");
  });

  it("undo route restores file and reverts applied proposal to pending", async () => {
    const original = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(tmpDir, "SOUL.md"), applied, "utf-8");
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Test",
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

    const result = await invokeRoute("/undo", { body: { id: key } });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toBe(original);
    expect(proposalsDb.get(proposal.id)?.status).toBe("pending");
  });

  it("list route includes undoable applied persona proposals", async () => {
    const { writeProposalRollback } = await import("../services/proposal-rollback.js");
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Applied item",
      observation: "obs",
      suggestedChange: "change",
      confidence: 0.9,
      evidenceSessions: [],
    });
    proposalsDb.updateStatusIf(proposal.id, "approved", "pending");
    proposalsDb.markAppliedIfApproved(proposal.id);
    const soulPath = join(tmpDir, "SOUL.md");
    writeFileSync(soulPath, "# SOUL\n", "utf-8");
    const content = readFileSync(soulPath, "utf-8");
    writeProposalRollback(join(tmpDir, "facts.db"), {
      proposalId: proposal.id,
      proposalType: "persona",
      targetPath: soulPath,
      originalHash: createHash("sha256").update(content).digest("hex"),
      originalContent: content,
      appliedHash: createHash("sha256").update(content).digest("hex"),
      appliedAt: new Date().toISOString(),
    });

    const listRoute = capturedRoutes.find((r) => r.path === `${PROPOSAL_API_PREFIX}/list`);
    const response = await listRoute!.handler({ method: "GET", url: `${PROPOSAL_API_PREFIX}/list`, headers: {} });
    const body = JSON.parse(response.body) as { proposals: Array<{ id: string; actions: { undoSupported: boolean } }> };
    const applied = body.proposals.find((p) => p.id === proposal.id);
    expect(applied?.actions.undoSupported).toBe(true);
  });
});

describe("registerProposalHttpRoutes change feed", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let changeFeed: ChangeFeed;
  let cfg: HybridMemoryConfig;

  beforeEach(() => {
    capturedRoutes.length = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-routes-feed-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    changeFeed = new ChangeFeed(factsDb);
    cfg = {
      health: { enabled: true, authenticated: true },
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

    registerProposalHttpRoutes({
      cfg: { health: cfg.health },
      cfgFull: cfg,
      factsDb,
      proposalsDb: null,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed,
      api: {
        registerHttpRoute: () => {},
        logger: { warn: () => {}, info: () => {} },
        context: { sessionKey: "chat-1" },
      } as unknown as ClawdbotPluginApi,
    });
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers change feed list route with sinceOrdinal support", async () => {
    changeFeed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "First",
      detail: "",
      proposalKey: "persona:a",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    changeFeed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Second",
      detail: "",
      proposalKey: "persona:b",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    expect(capturedRoutes.map((r) => r.path)).toContain(`${CHANGE_FEED_API_PREFIX}/list`);

    const route = capturedRoutes.find((r) => r.path === `${CHANGE_FEED_API_PREFIX}/list`);
    const response = await route!.handler({
      method: "GET",
      url: `${CHANGE_FEED_API_PREFIX}/list?session=chat-1&sinceOrdinal=1`,
      headers: {},
    });
    const body = JSON.parse(response.body) as { changes: Array<{ title: string; ordinal: number }> };
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]?.title).toBe("Second");
    expect(body.changes[0]?.ordinal).toBe(2);
  });

  it("change feed list requires session query param", async () => {
    const route = capturedRoutes.find((r) => r.path === `${CHANGE_FEED_API_PREFIX}/list`);
    const response = await route!.handler({
      method: "GET",
      url: `${CHANGE_FEED_API_PREFIX}/list`,
      headers: {},
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toContain("missing session");
  });

  it("change feed list rejects a session param that is not the caller's own session (loop iteration 35 regression: cross-session IDOR)", async () => {
    changeFeed.append({
      sessionKey: "victim-session",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Victim's private proposal",
      detail: "",
      proposalKey: "persona:victim",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    // The registered api.context is sessionKey "chat-1" (see beforeEach) — an attacker calling
    // as "chat-1" must not be able to read "victim-session"'s changes by simply naming it.
    const route = capturedRoutes.find((r) => r.path === `${CHANGE_FEED_API_PREFIX}/list`);
    const response = await route?.handler({
      method: "GET",
      url: `${CHANGE_FEED_API_PREFIX}/list?session=victim-session`,
      headers: {},
    });
    expect(response.status).toBe(403);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toContain("caller's own session");
  });

  it("change feed revert rejects an explicit session override that does not match the caller (loop iteration 35 regression: cross-session IDOR)", async () => {
    const victimEvent = changeFeed.append({
      sessionKey: "victim-session",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Victim's private proposal",
      detail: "",
      proposalKey: "persona:victim",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    const route = capturedRoutes.find((r) => r.path === `${CHANGE_FEED_API_PREFIX}/revert`);
    const response = await route?.handler({
      method: "POST",
      url: `${CHANGE_FEED_API_PREFIX}/revert`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "victim-session", ordinal: victimEvent.ordinal }),
    });
    expect(response.status).toBe(403);
    expect(changeFeed.getById(victimEvent.id)?.status).toBe("active");
  });

  it("change feed revert by id rejects reverting another session's event even without an explicit session override (loop iteration 35 regression: cross-session IDOR)", async () => {
    const victimEvent = changeFeed.append({
      sessionKey: "victim-session",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Victim's private proposal",
      detail: "",
      proposalKey: "persona:victim",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    // No `session`/`sessionKey` override — resolves to the caller's own trusted session
    // ("chat-1"), which the first check accepts. But `id` names a DIFFERENT session's event —
    // revertChangeById has no session check of its own, so the route must catch this.
    const route = capturedRoutes.find((r) => r.path === `${CHANGE_FEED_API_PREFIX}/revert`);
    const response = await route?.handler({
      method: "POST",
      url: `${CHANGE_FEED_API_PREFIX}/revert`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: victimEvent.id }),
    });
    expect(response.status).toBe(403);
    expect(changeFeed.getById(victimEvent.id)?.status).toBe("active");
  });

  it("reject route syncs pending proposed events into change feed", async () => {
    const proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Reject me",
      observation: "obs",
      suggestedChange: "Add guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);
    const proposed = changeFeed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Persona proposal pending",
      detail: "",
      proposalKey: key,
      rollbackAvailable: true,
      activation: "next-reload",
    });

    capturedRoutes.length = 0;
    registerProposalHttpRoutes({
      cfg: { health: cfg.health },
      cfgFull: cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed,
      api: {
        registerHttpRoute: () => {},
        logger: { warn: () => {}, info: () => {} },
      } as unknown as ClawdbotPluginApi,
    });

    const result = await invokeRoute("/reject", { body: { id: key, reason: "not now" } });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("rejected");
    expect(changeFeed.getById(proposed.id)?.status).toBe("reverted");
    proposalsDb.close();
  });
});
