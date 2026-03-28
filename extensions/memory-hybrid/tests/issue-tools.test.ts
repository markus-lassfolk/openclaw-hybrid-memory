/**
 * Tests for issue lifecycle tool registrations (Issue #137).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerIssueTools } from "../tools/issue-tools.js";
import { _testing } from "../index.js";

const { IssueStore } = _testing;

// ---------------------------------------------------------------------------
// Minimal mock API
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools = new Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => Promise<unknown> }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: Record<string, unknown>) {
      tools.set(opts.name as string, {
        opts,
        execute: opts.execute as (...args: unknown[]) => Promise<unknown>,
      });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    callTool(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let issueStore: InstanceType<typeof IssueStore>;
let api: ReturnType<typeof makeMockApi>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-tools-test-"));
  issueStore = new IssueStore(join(tmpDir, "issues.db"));
  api = makeMockApi();
  registerIssueTools({ issueStore }, api as any);
});

afterEach(() => {
  issueStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("registerIssueTools — tool registration", () => {
  it("registers memory_issue_create", () => {
    expect(api.getTool("memory_issue_create")).toBeDefined();
  });

  it("registers memory_issue_update", () => {
    expect(api.getTool("memory_issue_update")).toBeDefined();
  });

  it("registers memory_issue_list", () => {
    expect(api.getTool("memory_issue_list")).toBeDefined();
  });

  it("registers memory_issue_search", () => {
    expect(api.getTool("memory_issue_search")).toBeDefined();
  });

  it("registers memory_issue_link_fact", () => {
    expect(api.getTool("memory_issue_link_fact")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// memory_issue_create
// ---------------------------------------------------------------------------

describe("memory_issue_create", () => {
  it("creates an issue and returns content + details", async () => {
    const result = (await api.callTool("memory_issue_create", {
      title: "Login fails after deploy",
      symptoms: ["500 error on POST /auth", "JWT malformed"],
    })) as any;

    expect(result.content[0].text).toContain("Login fails after deploy");
    expect(result.details.status).toBe("open");
    expect(result.details.severity).toBe("medium");
    expect(result.details.symptoms).toEqual(["500 error on POST /auth", "JWT malformed"]);
    expect(result.details.id).toBeDefined();
  });

  it("creates with explicit severity", async () => {
    const result = (await api.callTool("memory_issue_create", {
      title: "Prod database down",
      symptoms: ["Connection refused"],
      severity: "critical",
    })) as any;

    expect(result.details.severity).toBe("critical");
    expect(result.details.status).toBe("open");
  });

  it("creates with tags", async () => {
    const result = (await api.callTool("memory_issue_create", {
      title: "Slow queries",
      symptoms: ["p99 > 3s"],
      tags: ["database", "performance"],
    })) as any;

    expect(result.details.tags).toEqual(["database", "performance"]);
  });

  it("creates with empty symptoms", async () => {
    const result = (await api.callTool("memory_issue_create", {
      title: "Unknown anomaly",
      symptoms: [],
    })) as any;

    expect(result.details.symptoms).toEqual([]);
    expect(result.details.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// memory_issue_update
// ---------------------------------------------------------------------------

describe("memory_issue_update", () => {
  it("updates rootCause without status change", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "API latency spike",
      symptoms: ["p99 > 2s"],
    })) as any;
    const id = created.details.id;

    const result = (await api.callTool("memory_issue_update", {
      id,
      rootCause: "Unindexed query in user service",
    })) as any;

    expect(result.details.rootCause).toBe("Unindexed query in user service");
    expect(result.details.status).toBe("open"); // status unchanged
  });

  it("transitions status with update tool", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Memory leak",
      symptoms: ["RSS grows"],
    })) as any;
    const id = created.details.id;

    const result = (await api.callTool("memory_issue_update", {
      id,
      status: "diagnosed",
      rootCause: "Event listener not cleaned up",
    })) as any;

    expect(result.details.status).toBe("diagnosed");
    expect(result.details.rootCause).toBe("Event listener not cleaned up");
  });

  it("auto-sets resolvedAt when transitioning to resolved", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Deployment crash",
      symptoms: ["App exits immediately"],
    })) as any;
    const id = created.details.id;

    await api.callTool("memory_issue_update", { id, status: "fix-attempted" });
    const result = (await api.callTool("memory_issue_update", { id, status: "resolved" })) as any;

    expect(result.details.resolvedAt).toBeDefined();
    expect(typeof result.details.resolvedAt).toBe("string");
  });

  it("auto-sets verifiedAt when transitioning to verified", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Race condition",
      symptoms: ["Intermittent failure"],
    })) as any;
    const id = created.details.id;

    await api.callTool("memory_issue_update", { id, status: "fix-attempted" });
    await api.callTool("memory_issue_update", { id, status: "resolved" });
    const result = (await api.callTool("memory_issue_update", { id, status: "verified" })) as any;

    expect(result.details.verifiedAt).toBeDefined();
  });

  it("throws on invalid state transition", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Test issue",
      symptoms: ["s"],
    })) as any;
    const id = created.details.id;

    await expect(api.callTool("memory_issue_update", { id, status: "verified" })).rejects.toThrow();
  });

  it("updates fix and rollback fields", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Bad migration",
      symptoms: ["Table missing"],
    })) as any;
    const id = created.details.id;

    const result = (await api.callTool("memory_issue_update", {
      id,
      fix: "Run migration 003",
      rollback: "Restore from backup",
    })) as any;

    expect(result.details.fix).toBe("Run migration 003");
    expect(result.details.rollback).toBe("Restore from backup");
  });
});

// ---------------------------------------------------------------------------
// memory_issue_list
// ---------------------------------------------------------------------------

describe("memory_issue_list", () => {
  it("lists all issues when no filter", async () => {
    await api.callTool("memory_issue_create", { title: "A", symptoms: ["s"] });
    await api.callTool("memory_issue_create", { title: "B", symptoms: ["s"] });

    const result = (await api.callTool("memory_issue_list", {})) as any;
    expect(result.details).toHaveLength(2);
    expect(result.content[0].text).toContain("2 issue(s)");
  });

  it("returns 'No issues found' when empty", async () => {
    const result = (await api.callTool("memory_issue_list", {})) as any;
    expect(result.content[0].text).toContain("No issues found");
  });

  it("filters by status", async () => {
    const c1 = (await api.callTool("memory_issue_create", { title: "Issue A", symptoms: ["s"] })) as any;
    await api.callTool("memory_issue_create", { title: "Issue B", symptoms: ["s"] });
    await api.callTool("memory_issue_update", { id: c1.details.id, status: "diagnosed" });

    const result = (await api.callTool("memory_issue_list", { status: ["diagnosed"] })) as any;
    expect(result.details).toHaveLength(1);
    expect(result.details[0].title).toBe("Issue A");
  });

  it("filters by severity", async () => {
    await api.callTool("memory_issue_create", { title: "Low", symptoms: ["s"], severity: "low" });
    await api.callTool("memory_issue_create", { title: "Critical", symptoms: ["s"], severity: "critical" });

    const result = (await api.callTool("memory_issue_list", { severity: ["critical"] })) as any;
    expect(result.details).toHaveLength(1);
    expect(result.details[0].title).toBe("Critical");
  });

  it("filters by tags", async () => {
    await api.callTool("memory_issue_create", { title: "API issue", symptoms: ["s"], tags: ["api"] });
    await api.callTool("memory_issue_create", { title: "DB issue", symptoms: ["s"], tags: ["database"] });

    const result = (await api.callTool("memory_issue_list", { tags: ["api"] })) as any;
    expect(result.details).toHaveLength(1);
    expect(result.details[0].title).toBe("API issue");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await api.callTool("memory_issue_create", { title: `Issue ${i}`, symptoms: ["s"] });
    }
    const result = (await api.callTool("memory_issue_list", { limit: 2 })) as any;
    expect(result.details).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// memory_issue_search
// ---------------------------------------------------------------------------

describe("memory_issue_search", () => {
  it("finds issues by title keyword", async () => {
    await api.callTool("memory_issue_create", { title: "Database timeout", symptoms: ["p99 > 5s"] });
    await api.callTool("memory_issue_create", { title: "CPU spike", symptoms: ["100% usage"] });

    const result = (await api.callTool("memory_issue_search", { query: "database" })) as any;
    expect(result.details).toHaveLength(1);
    expect(result.details[0].title).toBe("Database timeout");
  });

  it("finds issues by symptom keyword", async () => {
    await api.callTool("memory_issue_create", {
      title: "Auth failure",
      symptoms: ["JWT signature invalid"],
    });

    const result = (await api.callTool("memory_issue_search", { query: "JWT" })) as any;
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0].title).toBe("Auth failure");
  });

  it("returns 'No issues found' message when no match", async () => {
    await api.callTool("memory_issue_create", { title: "Unrelated", symptoms: ["other"] });
    const result = (await api.callTool("memory_issue_search", { query: "xyznotfound" })) as any;
    expect(result.content[0].text).toContain("No issues found");
    expect(result.details).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// memory_issue_link_fact
// ---------------------------------------------------------------------------

describe("memory_issue_link_fact", () => {
  it("links a fact to an issue", async () => {
    const created = (await api.callTool("memory_issue_create", {
      title: "Auth bug",
      symptoms: ["401"],
    })) as any;
    const id = created.details.id;

    const result = (await api.callTool("memory_issue_link_fact", {
      issueId: id,
      factId: "fact-abc-123",
    })) as any;

    expect(result.content[0].text).toContain("fact-abc-123");
    expect(result.details.issueId).toBe(id);
    expect(result.details.factId).toBe("fact-abc-123");

    // Verify it's stored
    const issue = issueStore.get(id)!;
    expect(issue.relatedFacts).toContain("fact-abc-123");
  });

  it("throws on nonexistent issue id", async () => {
    await expect(
      api.callTool("memory_issue_link_fact", { issueId: "nonexistent", factId: "fact-001" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end workflow
// ---------------------------------------------------------------------------

describe("End-to-end issue lifecycle via tools", () => {
  it("full lifecycle: create → diagnose → fix-attempt → resolve → verify", async () => {
    // 1. Create
    const created = (await api.callTool("memory_issue_create", {
      title: "Prod auth outage",
      symptoms: ["All login attempts return 500", "Error logs show NullPointerException"],
      severity: "critical",
      tags: ["production", "auth"],
    })) as any;

    const id = created.details.id;
    expect(created.details.status).toBe("open");

    // 2. Diagnose
    const diagnosed = (await api.callTool("memory_issue_update", {
      id,
      status: "diagnosed",
      rootCause: "Null session manager after container restart",
    })) as any;
    expect(diagnosed.details.status).toBe("diagnosed");

    // 3. Attempt fix
    const fixed = (await api.callTool("memory_issue_update", {
      id,
      status: "fix-attempted",
      fix: "Added null check and fallback session initialization",
      rollback: "Restart auth service with previous image",
    })) as any;
    expect(fixed.details.status).toBe("fix-attempted");

    // 4. Resolve
    const resolved = (await api.callTool("memory_issue_update", { id, status: "resolved" })) as any;
    expect(resolved.details.status).toBe("resolved");
    expect(resolved.details.resolvedAt).toBeDefined();

    // 5. Verify
    const verified = (await api.callTool("memory_issue_update", { id, status: "verified" })) as any;
    expect(verified.details.status).toBe("verified");
    expect(verified.details.verifiedAt).toBeDefined();

    // 6. Confirm via list (status=verified)
    const listResult = (await api.callTool("memory_issue_list", { status: ["verified"] })) as any;
    expect(listResult.details).toHaveLength(1);
    expect(listResult.details[0].id).toBe(id);
  });
});
