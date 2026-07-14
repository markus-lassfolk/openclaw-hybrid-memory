/**
 * Tests for memory_procedure_feedback tool contract (#1965–#1967).
 */
import { afterEach, describe, expect, it } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { buildProcedureNotFoundToolResult, executeProcedureFeedbackTool } from "../services/procedure-feedback-tool.js";

describe("procedure-feedback-tool (#1965–#1967)", () => {
  let db: FactsDB;

  afterEach(() => {
    db?.close();
  });

  it("buildProcedureNotFoundToolResult sets isError true with actionable details (#1965)", () => {
    const result = buildProcedureNotFoundToolResult("armor01-foundation-greenfield-rebuild-v1");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      success: false,
      error: "procedure_not_found",
      procedureId: "armor01-foundation-greenfield-rebuild-v1",
      hint: "use_memory_record_episode_or_recall_first",
    });
    expect(result.content[0]?.text).toContain("memory_record_episode");
    expect(result.content[0]?.text).toContain("does not create procedures");
  });

  it("executeProcedureFeedbackTool returns isError for unknown procedure without registerIfMissing (#1965)", () => {
    db = new FactsDB(":memory:");
    const result = executeProcedureFeedbackTool(db, {
      procedureId: "nonexistent-slug",
      success: true,
      context: "test",
    });
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("procedure_not_found");
  });

  it("executeProcedureFeedbackTool succeeds on existing procedure (#1965 regression)", () => {
    db = new FactsDB(":memory:");
    const proc = db.upsertProcedure({
      taskPattern: "Deploy service",
      recipeJson: JSON.stringify([{ tool: "exec", summary: "deploy" }]),
      procedureType: "positive",
    });
    const result = executeProcedureFeedbackTool(db, {
      procedureId: proc.id,
      success: true,
      context: "Clean deploy",
    });
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      success: true,
      procedureId: proc.id,
      outcome: "success",
    });
  });

  it("registerIfMissing creates draft procedure and records feedback (#1967)", () => {
    db = new FactsDB(":memory:");
    const slug = "armor01-foundation-greenfield-rebuild-v1";
    const result = executeProcedureFeedbackTool(db, {
      procedureId: slug,
      success: true,
      registerIfMissing: true,
      taskPattern: "Greenfield ARM rebuild foundation",
      steps: [{ tool: "exec", summary: "Run foundation script" }],
      context: "First successful run",
    });
    expect(result.isError).not.toBe(true);
    expect(result.details.created).toBe(true);
    expect(result.details.procedureId).toBe(slug);
    const stored = db.getProcedureById(slug);
    expect(stored?.taskPattern).toBe("Greenfield ARM rebuild foundation");
    expect(stored?.skillState).toBe("draft");
  });

  it("registerIfMissing is idempotent when procedure already exists (#1967)", () => {
    db = new FactsDB(":memory:");
    const proc = db.upsertProcedure({
      id: "existing-proc-id",
      taskPattern: "Existing workflow",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const result = executeProcedureFeedbackTool(db, {
      procedureId: proc.id,
      success: true,
      registerIfMissing: true,
      taskPattern: "Should be ignored",
      steps: [{ tool: "exec" }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.details.created).toBeUndefined();
    expect(db.getProcedureById(proc.id)?.taskPattern).toBe("Existing workflow");
  });

  it("registerIfMissing without taskPattern/steps returns validation error (#1967)", () => {
    db = new FactsDB(":memory:");
    const result = executeProcedureFeedbackTool(db, {
      procedureId: "new-slug",
      success: true,
      registerIfMissing: true,
    });
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("register_validation_failed");
  });

  it("rejects feedback on another tenant's scoped procedure as not-found (loop iteration 13 regression)", () => {
    db = new FactsDB(":memory:");
    const proc = db.upsertProcedure({
      taskPattern: "Bob's private deploy workflow",
      recipeJson: JSON.stringify([{ tool: "exec", summary: "deploy" }]),
      procedureType: "positive",
      scope: "user",
      scopeTarget: "bob",
    });

    const result = executeProcedureFeedbackTool(db, {
      procedureId: proc.id,
      success: true,
      context: "Alice trying to feedback on Bob's procedure",
      scopeFilter: { userId: "alice", agentId: null, sessionId: null },
    });

    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("procedure_not_found");
    const unchanged = db.getProcedureById(proc.id);
    expect(unchanged?.successCount).toBe(proc.successCount);
    expect(unchanged?.version).toBe(proc.version);
  });

  it("registerIfMissing scopes the auto-created procedure to the caller's tenant instead of defaulting to global (loop iteration 51 regression)", () => {
    db = new FactsDB(":memory:");
    const slug = "alice-only-deploy-workflow";
    const result = executeProcedureFeedbackTool(db, {
      procedureId: slug,
      success: true,
      registerIfMissing: true,
      taskPattern: "Alice's private deploy workflow",
      steps: [{ tool: "exec", summary: "deploy" }],
      scopeFilter: { userId: "alice", agentId: null, sessionId: null },
    });
    expect(result.isError).not.toBe(true);
    expect(result.details.created).toBe(true);

    const stored = db.getProcedureById(slug);
    expect(stored?.scope).toBe("user");
    expect(stored?.scopeTarget).toBe("alice");

    // A different tenant scoped-reading the same id must not see it (it should read as not-found).
    const bobRead = db.getProcedureById(slug, { userId: "bob", agentId: null, sessionId: null });
    expect(bobRead).toBeNull();
  });

  it("does not let registerIfMissing overwrite another tenant's procedure when the invented id collides (loop iteration 88 regression)", () => {
    db = new FactsDB(":memory:");
    const sharedId = "shared-workflow-slug";
    const bobProc = db.upsertProcedure({
      id: sharedId,
      taskPattern: "Bob's private deploy workflow",
      recipeJson: JSON.stringify([{ tool: "exec", summary: "bob-deploy" }]),
      procedureType: "positive",
      scope: "user",
      scopeTarget: "bob",
    });

    // Alice independently invents the same human-readable slug for her own procedure — her
    // scoped existence check correctly sees "not found for me" and proceeds to registerIfMissing.
    expect(() =>
      executeProcedureFeedbackTool(db, {
        procedureId: sharedId,
        success: true,
        registerIfMissing: true,
        taskPattern: "Alice's colliding workflow",
        steps: [{ tool: "exec", summary: "alice-deploy" }],
        scopeFilter: { userId: "alice", agentId: null, sessionId: null },
      }),
    ).toThrow(/already exists/);

    // Bob's procedure must be completely untouched — not overwritten, not reassigned to Alice.
    const unchanged = db.getProcedureById(sharedId, { userId: "bob", agentId: null, sessionId: null });
    expect(unchanged?.taskPattern).toBe("Bob's private deploy workflow");
    expect(unchanged?.scope).toBe("user");
    expect(unchanged?.scopeTarget).toBe("bob");
    expect(unchanged?.version).toBe(bobProc.version);
  });
});
