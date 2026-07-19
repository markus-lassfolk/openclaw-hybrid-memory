/** Tests for the Loom agent tools (Epic #2150) — registration + end-to-end tool flows. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { registerLoomTools } from "../tools/loom-tools.js";

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...a: unknown[]) => Promise<any> });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    call(name: string, params: Record<string, unknown>) {
      const t = tools.get(name);
      if (!t) throw new Error(`Tool not registered: ${name}`);
      return t.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const EMBEDDING = { provider: "ollama", model: "nomic-embed-text" };
const enabledCfg = parseConfig({ embedding: EMBEDDING, loom: { enabled: true } }) as any;
const disabledCfg = parseConfig({ embedding: EMBEDDING, loom: { enabled: false } }) as any;

const ALL_LOOM_TOOL_NAMES = [
  "memory_evidence_capsule_create",
  "memory_evidence_capsule_show",
  "memory_evidence_capsule_attach",
  "memory_evidence_capsule_list",
  "memory_belief_assert",
  "memory_belief_get",
  "memory_belief_verify",
  "memory_belief_contradict",
  "memory_belief_supersede",
  "memory_belief_explain",
  "memory_live_check_list",
  "memory_live_check_satisfy",
  "memory_live_check_require",
  "memory_loop_create",
  "memory_loop_list",
  "memory_loop_update",
  "memory_loop_close",
  "memory_drift_scout",
  "memory_lifecycle_candidates",
  "memory_lifecycle_update",
  "memory_attention_rank",
  "memory_attention_update",
  "memory_loom_brief",
  "memory_runway",
];

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;
let api: ReturnType<typeof makeMockApi>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loom-tools-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
  api = makeMockApi();
  registerLoomTools(
    { loomStore, factsDb, cfg: enabledCfg, currentAgentIdRef: { value: null }, buildToolScopeFilter: () => undefined },
    api as any,
  );
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Loom tools — registration", () => {
  it("registers every contracted Loom tool name", () => {
    for (const name of ALL_LOOM_TOOL_NAMES) {
      expect(api.getTool(name)).toBeDefined();
    }
  });

  it("returns loom_disabled when loom.enabled is false", async () => {
    const disabledApi = makeMockApi();
    registerLoomTools(
      {
        loomStore,
        factsDb,
        cfg: disabledCfg,
        currentAgentIdRef: { value: null },
        buildToolScopeFilter: () => undefined,
      },
      disabledApi as any,
    );
    const result = await disabledApi.call("memory_belief_assert", { entity: "x", key: "k", value: "v" });
    expect(result.details.error).toBe("loom_disabled");
  });
});

describe("end-to-end: evidence -> belief -> live-check -> loop -> brief", () => {
  it("creates an evidence capsule with redaction, a claim citing it, satisfies a live check, and reflects in the brief", async () => {
    const capsuleResult = await api.call("memory_evidence_capsule_create", {
      title: "Doris M365 auth restored",
      claim: "Doris can authenticate as doris@lassfolk.net",
      evidence: [{ kind: "command", text: "token: sk-ABCDEFGHIJKL12345678" }],
      commands_run: ["m365-agent-cli whoami"],
    });
    const capsuleId: string = capsuleResult.details.id;
    expect(capsuleId).toBeTruthy();
    expect(capsuleResult.details.capsule.redactionStatus).toBe("redacted");

    const assertResult = await api.call("memory_belief_assert", {
      entity: "Doris",
      key: "m365_identity",
      value: "doris@lassfolk.net",
      evidence_capsule_ids: [capsuleId],
      live_check_required: true,
      live_check_reason: "mutable external auth state",
      suggested_checks: [{ kind: "command", text: "m365-agent-cli whoami", expected: "doris@lassfolk.net" }],
    });
    const claimId: string = assertResult.details.id;
    expect(assertResult.details.claim.status).toBe("must_live_check");

    const listResult = await api.call("memory_live_check_list", {});
    expect(listResult.details.items.some((x: any) => x.claim.id === claimId)).toBe(true);

    await api.call("memory_live_check_satisfy", { claim_id: claimId, evidence_capsule_id: capsuleId });
    const explain = await api.call("memory_belief_explain", { claim_id: claimId });
    expect(explain.details.claim.status).toBe("verified");

    const loopResult = await api.call("memory_loop_create", {
      title: "Verify Doris M365 auth",
      loop_type: "needs_verification",
      scope: "Doris",
      closure_criteria: "whoami succeeds",
    });
    expect(loopResult.details.id).toBeTruthy();

    const briefResult = await api.call("memory_loom_brief", { scope: "Doris" });
    expect(briefResult.details.brief.openLoops.length).toBe(1);
    expect(briefResult.details.brief.verifiedBeliefs.some((b: any) => b.claimId === claimId)).toBe(true);
  });
});

describe("drift scout tool", () => {
  it("scans facts for a deprecated command and reports it", async () => {
    factsDb.store({
      text: "Run old-report-cmd weekly.",
      category: "project",
      importance: 0.5,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const cfgWithDeprecated = parseConfig({
      embedding: EMBEDDING,
      loom: { enabled: true, drift: { deprecatedCommands: { "old-report-cmd": "new-report-cmd" } } },
    }) as any;
    const localApi = makeMockApi();
    registerLoomTools(
      {
        loomStore,
        factsDb,
        cfg: cfgWithDeprecated,
        currentAgentIdRef: { value: null },
        buildToolScopeFilter: () => undefined,
      },
      localApi as any,
    );
    const result = await localApi.call("memory_drift_scout", {});
    expect(result.details.newCount).toBe(1);
  });
});

describe("lifecycle tools", () => {
  it("candidates is report-only; update requires confirm for delete", async () => {
    const fact = factsDb.store({
      text: "Duplicate note.",
      category: "fact",
      importance: 0.2,
      source: "conversation",
      entity: null,
      key: null,
      value: null,
    });
    const candidates = await api.call("memory_lifecycle_candidates", {});
    expect(Array.isArray(candidates.details.candidates)).toBe(true);

    const denied = await api.call("memory_lifecycle_update", {
      target_kind: "fact",
      target_id: fact.id,
      action: "delete",
      reason: "cleanup",
    });
    expect(denied.details.error).toBe("LifecycleConfirmRequiredError");

    const allowed = await api.call("memory_lifecycle_update", {
      target_kind: "fact",
      target_id: fact.id,
      action: "demote",
      reason: "noisy",
    });
    expect(allowed.details.ok).toBe(true);
  });
});

describe("attention tools", () => {
  it("ranks and then snoozes an item", async () => {
    await api.call("memory_belief_assert", {
      entity: "A",
      key: "k",
      value: "v",
      live_check_required: true,
      live_check_reason: "x",
    });
    const rank = await api.call("memory_attention_rank", {});
    expect(rank.details.items.length).toBeGreaterThan(0);
    const targetId = rank.details.items[0].targetId;
    const targetKind = rank.details.items[0].targetKind;
    const snoozed = await api.call("memory_attention_update", {
      target_kind: targetKind,
      target_id: targetId,
      action: "snooze",
      until: "2099-01-01",
    });
    expect(snoozed.details.override.action).toBe("snooze");
  });
});

describe("runway tool", () => {
  it("returns a bundle without throwing on an empty workspace", async () => {
    const result = await api.call("memory_runway", {});
    expect(result.details.warnings[0]).toContain("Memory is context, not proof");
  });
});
