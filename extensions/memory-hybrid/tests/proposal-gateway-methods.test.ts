// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";
import { makeUnifiedKey } from "../services/unified-proposals.js";
import { writeProposalRollback } from "../services/proposal-rollback.js";
import { registerProposalGatewayMethods } from "../tools/proposal-gateway-methods.js";
import { ChangeFeed } from "../services/change-feed.js";
import { setEnv } from "../utils/env-manager.js";

const { FactsDB } = _testing;

type RegisteredMethod = {
  method: string;
  handler: (opts: {
    params: Record<string, unknown>;
    respond: (ok: boolean, payload?: unknown, error?: { message: string }) => void;
  }) => void | Promise<void>;
};

function makeGatewayApi(opts?: { context?: Record<string, unknown> }): {
  api: ClawdbotPluginApi;
  methods: RegisteredMethod[];
} {
  const methods: RegisteredMethod[] = [];
  const api = {
    registerGatewayMethod: (method: string, handler: RegisteredMethod["handler"]) => {
      methods.push({ method, handler });
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    context: opts?.context,
  } as unknown as ClawdbotPluginApi;
  return { api, methods };
}

async function callMethod(
  methods: RegisteredMethod[],
  name: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: { message: string } }> {
  const entry = methods.find((m) => m.method === name);
  expect(entry).toBeDefined();
  return new Promise((resolve) => {
    entry!.handler({
      params,
      respond: (ok, payload, error) => resolve({ ok, payload, error }),
    });
  });
}

describe("registerProposalGatewayMethods", () => {
  let tmpDir: string;
  let proposalsDb: ProposalsDB;
  let factsDb: InstanceType<typeof FactsDB>;
  let cfg: HybridMemoryConfig;
  let methods: RegisteredMethod[];
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-gateway-"));
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

    const { api, methods: registered } = makeGatewayApi();
    methods = registered;
    registerProposalGatewayMethods({
      cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed: null,
      api,
    });
  });

  afterEach(() => {
    proposalsDb.close();
    factsDb.close();
    if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers core hybrid-mem.proposals.* methods when workshop is enabled", () => {
    expect(methods.map((m) => m.method)).toEqual(
      expect.arrayContaining([
        "hybrid-mem.proposals.list",
        "hybrid-mem.proposals.reject",
        "hybrid-mem.proposals.undo",
        "hybrid-mem.proposals.inspect",
      ]),
    );
  });

  it("registers gateway methods even when health.enabled is false", () => {
    const localMethods: RegisteredMethod[] = [];
    const api = {
      registerGatewayMethod: (method: string, handler: RegisteredMethod["handler"]) => {
        localMethods.push({ method, handler });
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as unknown as ClawdbotPluginApi;
    registerProposalGatewayMethods({
      cfg: { ...cfg, health: { enabled: false, authenticated: true } },
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed: null,
      api,
    });
    expect(localMethods.map((m) => m.method)).toContain("hybrid-mem.proposals.list");
  });

  it("registers gateway methods when cfg is health-only and cfgFull carries workshop config", async () => {
    proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Split-context register",
      observation: "obs",
      suggestedChange: "change",
      confidence: 0.8,
      evidenceSessions: [],
    });
    const localMethods: RegisteredMethod[] = [];
    const api = {
      registerGatewayMethod: (method: string, handler: RegisteredMethod["handler"]) => {
        localMethods.push({ method, handler });
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as unknown as ClawdbotPluginApi;
    registerProposalGatewayMethods({
      cfg: { health: { enabled: true, authenticated: true } } as HybridMemoryConfig,
      cfgFull: cfg,
      factsDb,
      proposalsDb,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed: null,
      api,
    });
    expect(localMethods.map((m) => m.method)).toContain("hybrid-mem.proposals.list");
    const list = await callMethod(localMethods, "hybrid-mem.proposals.list", { limit: 10 });
    expect(list.ok).toBe(true);
    expect((list.payload as { pendingCount: number }).pendingCount).toBeGreaterThan(0);
  });

  it("hybrid-mem.proposals.reject rejects a pending persona proposal", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Gateway reject",
      observation: "obs",
      suggestedChange: "Add guidance.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);

    const result = await callMethod(methods, "hybrid-mem.proposals.reject", { id: key, reason: "nope" });
    expect(result.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("rejected");
  });

  it("hybrid-mem.proposals.inspect returns a proposal by unified key", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Inspect me",
      observation: "obs",
      suggestedChange: "change",
      confidence: 0.8,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);

    const result = await callMethod(methods, "hybrid-mem.proposals.inspect", { id: key });
    expect(result.ok).toBe(true);
    expect((result.payload as { id: string }).id).toBe(proposal.id);
  });

  it("hybrid-mem.proposals.list includes pending persona proposals", async () => {
    proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Listed",
      observation: "obs",
      suggestedChange: "change",
      confidence: 0.8,
      evidenceSessions: [],
    });

    const result = await callMethod(methods, "hybrid-mem.proposals.list", { limit: 10 });
    expect(result.ok).toBe(true);
    const payload = result.payload as { proposals: unknown[]; pendingCount: number };
    expect(payload.proposals.length).toBeGreaterThan(0);
    expect(payload.pendingCount).toBeGreaterThan(0);
  });

  it("hybrid-mem.proposals.approve applies a pending persona proposal", async () => {
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Approve via RPC",
      observation: "obs",
      suggestedChange: "Use evidence-backed replies.",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const key = makeUnifiedKey("persona", proposal.id);

    const result = await callMethod(methods, "hybrid-mem.proposals.approve", { id: key });
    expect(result.ok).toBe(true);
    expect(proposalsDb.get(proposal.id)?.status).toBe("applied");
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toContain("Use evidence-backed replies.");
  });

  it("hybrid-mem.proposals.undo restores an applied persona proposal", async () => {
    const original = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    const applied = "# SOUL\nInitial.\n\nApplied guidance.\n";
    writeFileSync(join(tmpDir, "SOUL.md"), applied, "utf-8");
    const proposal = proposalsDb.create({
      targetFile: "SOUL.md",
      title: "Undo via RPC",
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

    const result = await callMethod(methods, "hybrid-mem.proposals.undo", { id: key });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(tmpDir, "SOUL.md"), "utf-8")).toBe(original);
    expect(proposalsDb.get(proposal.id)?.status).toBe("pending");
  });
});

describe("registerProposalGatewayMethods change feed", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let changeFeed: ChangeFeed;
  let cfg: HybridMemoryConfig;
  let methods: RegisteredMethod[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-gateway-feed-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    changeFeed = new ChangeFeed(factsDb);
    cfg = {
      health: { enabled: true, authenticated: true },
      liveChangeFeed: { enabled: true },
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
    } as HybridMemoryConfig;
    const { api, methods: registered } = makeGatewayApi({ context: { sessionKey: "chat-1" } });
    methods = registered;
    registerProposalGatewayMethods({
      cfg,
      factsDb,
      proposalsDb: null,
      crystallizationStore: null,
      toolProposalStore: null,
      workflowStore: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      changeFeed,
      api,
    });
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers hybrid-mem.changes.list when changeFeed is available", () => {
    expect(methods.map((m) => m.method)).toContain("hybrid-mem.changes.list");
  });

  it("hybrid-mem.changes.list supports sinceOrdinal", async () => {
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

    const result = await callMethod(methods, "hybrid-mem.changes.list", {
      sessionKey: "chat-1",
      sinceOrdinal: 1,
      limit: 10,
    });
    expect(result.ok).toBe(true);
    const changes = (result.payload as { changes: Array<{ title: string; ordinal: number }> }).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.title).toBe("Second");
  });

  it("hybrid-mem.changes.list requires sessionKey", async () => {
    const result = await callMethod(methods, "hybrid-mem.changes.list", { limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("missing sessionKey");
  });

  it("hybrid-mem.changes.list rejects a sessionKey that is not the caller's own session (loop iteration 35 regression: cross-session IDOR)", async () => {
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

    // makeGatewayApi() is set up with context.sessionKey "chat-1" (see beforeEach) — an
    // attacker calling as "chat-1" must not be able to read "victim-session"'s changes.
    const result = await callMethod(methods, "hybrid-mem.changes.list", { sessionKey: "victim-session", limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("caller's own session");
  });

  it("hybrid-mem.changes.revert rejects an explicit sessionKey override that does not match the caller (loop iteration 35 regression: cross-session IDOR)", async () => {
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

    const result = await callMethod(methods, "hybrid-mem.changes.revert", {
      sessionKey: "victim-session",
      ordinal: victimEvent.ordinal,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("caller's own session");
    expect(changeFeed.getById(victimEvent.id)?.status).toBe("active");
  });

  it("hybrid-mem.changes.revert by id rejects reverting another session's event even without an explicit sessionKey override (loop iteration 35 regression: cross-session IDOR)", async () => {
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

    // No sessionKey override — resolves to the caller's own trusted session ("chat-1"), which
    // the first check accepts. But `id` names a DIFFERENT session's event — revertChangeById has
    // no session check of its own, so the handler must catch this.
    const result = await callMethod(methods, "hybrid-mem.changes.revert", { id: victimEvent.id });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("caller's own session");
    expect(changeFeed.getById(victimEvent.id)?.status).toBe("active");
  });
});
