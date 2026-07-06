/**
 * Regression coverage for issue-tools.ts's missing scope enforcement (loop iteration 29):
 * memory_issue_link_fact and the auto-linking triggered by memory_issue_create/memory_issue_update
 * called factsDb.search/factsDb.getById with no scopeFilter at all, unlike graph-tools.ts's
 * memory_link (which has an explicit "SECURITY" comment for this exact pattern). This let a caller
 * tie another tenant's fact into issue.relatedFacts, disclosed back via memory_issue_list/get.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const { FactsDB, IssueStore } = _testing;

type ToolMap = Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;

describe("issue tools scope enforcement (loop iteration 29 regression)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let issueStore: InstanceType<typeof IssueStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-tools-scope-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    issueStore = new IssueStore(join(tmpDir, "issues.db"));
  });

  afterEach(() => {
    factsDb.close();
    issueStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerTools(): ToolMap {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
    });
    const tools: ToolMap = new Map();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: {
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
      }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
      },
    };
    registerIssueTools(
      {
        issueStore,
        factsDb,
        cfg,
        currentAgentIdRef: { value: "tenantA" },
        buildToolScopeFilter,
      },
      api as ClawdbotPluginApi,
    );
    return tools;
  }

  it("memory_issue_link_fact rejects linking a fact scoped to a different tenant", async () => {
    const bobFact = factsDb.store({
      text: "Bob's confidential deployment credential",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantB",
    });

    const tools = registerTools();
    const create = tools.get("memory_issue_create");
    const created = (await create?.execute("tc", {
      title: "Auth bug",
      symptoms: ["401"],
    })) as { details?: { id?: string } };
    const issueId = created.details?.id as string;

    const linkFact = tools.get("memory_issue_link_fact");
    const result = (await linkFact?.execute("tc", {
      issueId,
      factId: bobFact.id,
    })) as { details?: { error?: string } };

    expect(result.details?.error).toBe("fact_not_found");
    const issue = issueStore.get(issueId);
    expect(issue?.relatedFacts).not.toContain(bobFact.id);
  });

  it("memory_issue_link_fact still links a fact in the caller's own scope", async () => {
    const ownFact = factsDb.store({
      text: "My own deployment note",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });

    const tools = registerTools();
    const create = tools.get("memory_issue_create");
    const created = (await create?.execute("tc", {
      title: "Auth bug",
      symptoms: ["401"],
    })) as { details?: { id?: string } };
    const issueId = created.details?.id as string;

    const linkFact = tools.get("memory_issue_link_fact");
    const result = (await linkFact?.execute("tc", {
      issueId,
      factId: ownFact.id,
    })) as { details?: { error?: string } };

    expect(result.details?.error).toBeUndefined();
    const issue = issueStore.get(issueId);
    expect(issue?.relatedFacts).toContain(ownFact.id);
  });

  it("memory_issue_create's auto-link does not pull in another tenant's fact", async () => {
    const bobFact = factsDb.store({
      text: "database connection pool exhausted during deploy rollout",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantB",
    });

    const tools = registerTools();
    const create = tools.get("memory_issue_create");
    const created = (await create?.execute("tc", {
      title: "database connection pool exhausted during deploy rollout",
      symptoms: ["database connection pool exhausted during deploy rollout"],
    })) as { details?: { id?: string } };
    const issueId = created.details?.id as string;

    // maybeAutoLink runs after the tool's own response snapshot is built, so re-fetch from the
    // store (not the tool response) to see the actual post-auto-link state.
    const issue = issueStore.get(issueId);
    expect(issue?.relatedFacts ?? []).not.toContain(bobFact.id);
  });
});
