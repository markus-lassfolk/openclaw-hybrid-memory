/**
 * Tests for the serendipity_* agent tools (Issue #2119).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueStore } from "../backends/issue-store.js";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { registerSerendipityTools } from "../tools/serendipity-tools.js";

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
const cfg = parseConfig({ embedding: EMBEDDING, serendipityProtocol: { enabled: true } }) as any;

let tmpDir: string;
let store: SerendipityStore;
let issueStore: IssueStore;
let api: ReturnType<typeof makeMockApi>;
let savedStateDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-tools-test-"));
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
  issueStore = new IssueStore(join(tmpDir, "issues.db"));
  savedStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir; // route Skill Workshop proposals into tmp
  api = makeMockApi();
  registerSerendipityTools(
    {
      serendipityStore: store,
      issueStore,
      cfg,
      currentAgentIdRef: { value: null },
      buildToolScopeFilter: () => undefined,
    },
    api as any,
  );
});

afterEach(() => {
  store.close();
  issueStore.close();
  if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = savedStateDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("serendipity tools — registration", () => {
  it("registers all tools", () => {
    for (const name of [
      "serendipity_record",
      "serendipity_list",
      "serendipity_decide",
      "serendipity_resolve",
      "serendipity_digest",
      "serendipity_promote",
      "serendipity_set_level",
    ]) {
      expect(api.getTool(name)).toBeDefined();
    }
  });
});

describe("serendipity_record", () => {
  it("records a finding and dedups on a repeat", async () => {
    const r1 = await api.call("serendipity_record", {
      title: "apache-arrow missing",
      description: "lancedb needs it",
      finding_type: "packaging_defect",
      evidence: ["package.json diff"],
    });
    expect(r1.details.id).toBeTruthy();
    const r2 = await api.call("serendipity_record", {
      title: "apache-arrow missing",
      description: "lancedb needs it",
      finding_type: "packaging_defect",
      evidence: ["second observation"],
    });
    expect(r2.details.deduped).toBe(true);
    expect(r2.details.id).toBe(r1.details.id);
    expect(store.list()).toHaveLength(1);
    expect(store.get(r1.details.id)?.evidence).toContain("second observation");
  });
});

describe("serendipity_list", () => {
  it("lists findings and the backlog", async () => {
    await api.call("serendipity_record", {
      title: "t1",
      description: "d",
      finding_type: "packaging_defect",
      suggested_action: "fix_now",
      adjacency: "direct",
    });
    const all = await api.call("serendipity_list", {});
    expect(all.details.count).toBe(1);
    const backlog = await api.call("serendipity_list", { backlog: true });
    expect(backlog.details.count).toBe(1);
  });
});

describe("serendipity_decide", () => {
  it("recommends an action for the resolved level", async () => {
    const rec = await api.call("serendipity_record", {
      title: "safety",
      description: "d",
      finding_type: "packaging_defect",
      risk_level: "low",
      reversibility: "easy",
      adjacency: "direct",
    });
    const decision = await api.call("serendipity_decide", { finding_id: rec.details.id });
    expect(decision.details.action).toBe("fix_now");
    expect(typeof decision.details.rationale).toBe("string");
  });
});

describe("serendipity_resolve", () => {
  it("files a linked local issue when status=filed", async () => {
    const rec = await api.call("serendipity_record", {
      title: "packaging bug",
      description: "d",
      finding_type: "packaging_defect",
      risk_level: "high",
      evidence: ["evidence line"],
    });
    const res = await api.call("serendipity_resolve", { finding_id: rec.details.id, status: "filed" });
    expect(res.details.finding.status).toBe("filed");
    expect(res.details.issue_id).toBeTruthy();
    const issue = issueStore.get(res.details.issue_id);
    expect(issue?.title).toBe("packaging bug");
    expect(issue?.severity).toBe("high");
    expect(store.get(rec.details.id)?.relatedIssues).toContain(res.details.issue_id);
  });
});

describe("serendipity_digest", () => {
  it("returns a markdown digest", async () => {
    await api.call("serendipity_record", {
      title: "t",
      description: "d",
      finding_type: "packaging_defect",
      suggested_action: "fix_now",
    });
    const dg = await api.call("serendipity_digest", { since: "7d" });
    expect(dg.content[0].text).toContain("Serendipity digest");
    expect(dg.details.report.backlog.actionable).toBe(1);
  });
});

describe("serendipity_promote", () => {
  it("promotes a finding to a Skill Workshop proposal", async () => {
    const rec = await api.call("serendipity_record", {
      title: "recurring friction",
      description: "d",
      finding_type: "repeated_friction",
    });
    const res = await api.call("serendipity_promote", { finding_id: rec.details.id, target: "skill" });
    expect(res.details.ok).toBe(true);
    expect(store.get(rec.details.id)?.status).toBe("proposed");
  });
});

describe("serendipity_set_level", () => {
  it("stores a scoped engagement level", async () => {
    const res = await api.call("serendipity_set_level", { level: 3, scope: "user", target: "markus" });
    expect(res.details.pref.level).toBe(3);
    expect(store.getLevelPref("user", "markus")?.level).toBe(3);
  });
});

describe("disabled gate", () => {
  it("reports disabled when serendipityProtocol.enabled is false", async () => {
    const disabledCfg = parseConfig({ embedding: EMBEDDING, serendipityProtocol: { enabled: false } }) as any;
    const api2 = makeMockApi();
    registerSerendipityTools(
      {
        serendipityStore: null,
        issueStore: null,
        cfg: disabledCfg,
        currentAgentIdRef: { value: null },
        buildToolScopeFilter: () => undefined,
      },
      api2 as any,
    );
    const r = await api2.call("serendipity_record", {
      title: "x",
      description: "y",
      finding_type: "other",
    });
    expect(r.details.error).toBe("serendipity_disabled");
  });
});
