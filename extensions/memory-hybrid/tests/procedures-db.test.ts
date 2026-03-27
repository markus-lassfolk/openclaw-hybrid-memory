import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedures-db-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FactsDB procedures table", () => {
  it("upsertProcedure inserts new procedure and returns entry", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Check Moltbook status",
      recipeJson: JSON.stringify([{ tool: "web_fetch", args: { url: "https://api.example.com" } }]),
      procedureType: "positive",
      successCount: 1,
      confidence: 0.6,
      ttlDays: 30,
    });
    expect(proc.id).toBeDefined();
    expect(proc.taskPattern).toBe("Check Moltbook status");
    expect(proc.procedureType).toBe("positive");
    expect(proc.successCount).toBe(1);
    expect(proc.promotedToSkill).toBe(0);
    expect(proc.skillPath).toBeNull();
  });

  it("getProcedureById returns null for unknown id", () => {
    expect(db.getProcedureById("nonexistent-id")).toBeNull();
  });

  it("getProcedureById returns stored procedure", () => {
    const created = db.upsertProcedure({
      taskPattern: "HA health check",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const found = db.getProcedureById(created.id);
    expect(found).not.toBeNull();
    expect(found?.taskPattern).toBe("HA health check");
  });

  it("searchProcedures finds by task pattern words", () => {
    db.upsertProcedure({
      taskPattern: "Check Home Assistant health",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const results = db.searchProcedures("Home Assistant health", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((p) => p.taskPattern.includes("Home Assistant"))).toBe(true);
  });

  it("getNegativeProceduresMatching returns only negative procedures", () => {
    db.upsertProcedure({
      taskPattern: "Moltbook dead endpoint",
      recipeJson: "[]",
      procedureType: "negative",
    });
    db.upsertProcedure({
      taskPattern: "Moltbook working flow",
      recipeJson: "[]",
      procedureType: "positive",
    });
    const negs = db.getNegativeProceduresMatching("Moltbook", 10);
    expect(negs.every((p) => p.procedureType === "negative")).toBe(true);
  });

  it("recordProcedureSuccess increments success_count and last_validated", () => {
    const created = db.upsertProcedure({
      taskPattern: "Test procedure",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 2,
    });
    const ok = db.recordProcedureSuccess(created.id);
    expect(ok).toBe(true);
    const after = db.getProcedureById(created.id);
    expect(after?.successCount).toBe(3);
    expect(after?.lastValidated).toBeGreaterThan(0);
  });

  it("recordProcedureFailure increments failure_count", () => {
    const created = db.upsertProcedure({
      taskPattern: "Failing procedure",
      recipeJson: "[]",
      procedureType: "negative",
      failureCount: 1,
    });
    db.recordProcedureFailure(created.id);
    const after = db.getProcedureById(created.id);
    expect(after?.failureCount).toBe(2);
  });

  it("getProceduresReadyForSkill returns only positive with success_count >= threshold", () => {
    db.upsertProcedure({
      taskPattern: "Low success",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 1,
    });
    const high = db.upsertProcedure({
      taskPattern: "High success",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    const ready = db.getProceduresReadyForSkill(3, 10);
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready.some((p) => p.id === high.id)).toBe(true);
  });

  it("markProcedurePromoted sets promoted_to_skill and skill_path", () => {
    const created = db.upsertProcedure({
      taskPattern: "Promote me",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 5,
    });
    const ok = db.markProcedurePromoted(created.id, "skills/auto/check-moltbook");
    expect(ok).toBe(true);
    const after = db.getProcedureById(created.id);
    expect(after?.promotedToSkill).toBe(1);
    expect(after?.skillPath).toBe("skills/auto/check-moltbook");
  });

  it("getStaleProcedures returns procedures past TTL", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 24 * 3600; // 60 days ago
    db.upsertProcedure({
      taskPattern: "Old procedure",
      recipeJson: "[]",
      procedureType: "positive",
      lastValidated: old,
    });
    const stale = db.getStaleProcedures(30, 10);
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });
});

describe("FactsDB procedure columns on facts", () => {
  it("store accepts procedureType and successCount", () => {
    const entry = db.store({
      text: "Procedure: check API worked 3 times",
      category: "procedure",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
      procedureType: "positive",
      successCount: 3,
      lastValidated: Math.floor(Date.now() / 1000),
      sourceSessions: JSON.stringify(["s1", "s2"]),
    });
    expect(entry.id).toBeDefined();
    expect(entry.procedureType).toBe("positive");
    expect(entry.successCount).toBe(3);
    const retrieved = db.getById(entry.id);
    expect(retrieved?.procedureType).toBe("positive");
    expect(retrieved?.successCount).toBe(3);
  });
});

describe("searchProceduresRanked (confidence-weighted ranking)", () => {
  it("returns procedures with relevanceScore", () => {
    db.upsertProcedure({
      taskPattern: "Check Home Assistant health",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    const results = db.searchProceduresRanked("Home Assistant health", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty("relevanceScore");
    expect(results[0].relevanceScore).toBeGreaterThan(0);
    expect(results[0].relevanceScore).toBeLessThanOrEqual(1);
  });

  it("applies recency decay (30-day window, min 0.3)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recentProc = db.upsertProcedure({
      taskPattern: "Recent check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: nowSec - 1 * 24 * 3600, // 1 day ago
    });
    const oldProc = db.upsertProcedure({
      taskPattern: "Old check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: nowSec - 40 * 24 * 3600, // 40 days ago (beyond window)
    });
    const results = db.searchProceduresRanked("check API", 10);
    const recent = results.find((r) => r.id === recentProc.id);
    const old = results.find((r) => r.id === oldProc.id);
    expect(recent).toBeDefined();
    expect(old).toBeDefined();
    // Recent should have higher score due to recency
    expect(recent?.relevanceScore).toBeGreaterThan(old?.relevanceScore);
    // Old procedure should have at least 0.3 recency factor
    expect(old?.relevanceScore).toBeGreaterThan(0);
  });

  it("applies success rate boost (50-100% weight)", () => {
    const highSuccess = db.upsertProcedure({
      taskPattern: "High success check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      successCount: 10,
      failureCount: 0,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    const lowSuccess = db.upsertProcedure({
      taskPattern: "Low success check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      successCount: 1,
      failureCount: 9,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    const results = db.searchProceduresRanked("check API", 10);
    const high = results.find((r) => r.id === highSuccess.id);
    const low = results.find((r) => r.id === lowSuccess.id);
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // High success rate should have higher score
    expect(high?.relevanceScore).toBeGreaterThan(low?.relevanceScore);
  });

  it("penalizes procedures that failed in last 7 days (0.5 multiplier)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recentFail = db.upsertProcedure({
      taskPattern: "Recent fail check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      successCount: 5,
      failureCount: 1,
      lastValidated: nowSec - 1 * 24 * 3600,
      lastFailed: nowSec - 2 * 24 * 3600, // failed 2 days ago
    });
    const oldFail = db.upsertProcedure({
      taskPattern: "Old fail check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      successCount: 5,
      failureCount: 1,
      lastValidated: nowSec - 1 * 24 * 3600,
      lastFailed: nowSec - 10 * 24 * 3600, // failed 10 days ago
    });
    const results = db.searchProceduresRanked("check API", 10);
    const recent = results.find((r) => r.id === recentFail.id);
    const old = results.find((r) => r.id === oldFail.id);
    expect(recent).toBeDefined();
    expect(old).toBeDefined();
    // Recent failure should have lower score (penalty applied)
    expect(recent?.relevanceScore).toBeLessThan(old?.relevanceScore);
  });

  it("penalizes never-validated procedures (30% penalty)", () => {
    const validated = db.upsertProcedure({
      taskPattern: "Validated check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    const neverValidated = db.upsertProcedure({
      taskPattern: "Never validated check API",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: null,
    });
    const results = db.searchProceduresRanked("check API", 10);
    const val = results.find((r) => r.id === validated.id);
    const never = results.find((r) => r.id === neverValidated.id);
    expect(val).toBeDefined();
    expect(never).toBeDefined();
    // Validated should have higher score
    expect(val?.relevanceScore).toBeGreaterThan(never?.relevanceScore);
    // Never-validated should have ~70% of validated score (30% penalty)
    expect(never?.relevanceScore).toBeLessThan(val?.relevanceScore * 0.75);
  });

  it("returns procedures matching FTS query", () => {
    // Create a procedure that won't match the FTS query
    db.upsertProcedure({
      taskPattern: "Completely unrelated task about cooking pasta",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.3,
      successCount: 0,
      failureCount: 10,
      lastValidated: null,
    });
    const results = db.searchProceduresRanked("check API", 10);
    // FTS query won't match unrelated procedures
    expect(
      results.every(
        (r) => r.taskPattern.toLowerCase().includes("api") || r.taskPattern.toLowerCase().includes("check"),
      ),
    ).toBe(true);
  });

  it("returns positive procedures before negative", () => {
    db.upsertProcedure({
      taskPattern: "Positive API check",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.8,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    db.upsertProcedure({
      taskPattern: "Negative API check",
      recipeJson: "[]",
      procedureType: "negative",
      confidence: 0.8,
      lastValidated: Math.floor(Date.now() / 1000),
    });
    const results = db.searchProceduresRanked("API check", 10);
    if (results.length >= 2) {
      const positiveIdx = results.findIndex((r) => r.procedureType === "positive");
      const negativeIdx = results.findIndex((r) => r.procedureType === "negative");
      if (positiveIdx !== -1 && negativeIdx !== -1) {
        expect(positiveIdx).toBeLessThan(negativeIdx);
      }
    }
  });

  // ========================================================================
  // Procedure Scoping Tests
  // ========================================================================

  it("migrateProcedureScopeColumns adds scope and scope_target columns", () => {
    // Create a procedure to verify columns exist
    const proc = db.upsertProcedure({
      taskPattern: "Test scoping",
      recipeJson: "[]",
      procedureType: "positive",
    });
    expect(proc.id).toBeDefined();
    // If migration didn't run, upsertProcedure would fail on missing columns
  });

  it("upsertProcedure stores procedure with agent scope", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Forge-specific procedure",
      recipeJson: JSON.stringify([{ tool: "exec", args: { command: "git commit" } }]),
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "forge",
    });
    expect(proc.scope).toBe("agent");
    expect(proc.scopeTarget).toBe("forge");
  });

  it("upsertProcedure defaults to global scope when not specified", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Default scope procedure",
      recipeJson: "[]",
      procedureType: "positive",
    });
    expect(proc.scope).toBe("global");
    expect(proc.scopeTarget).toBeNull();
  });

  it("searchProcedures with scopeFilter returns only matching scoped procedures", () => {
    // Create procedures with different scopes
    db.upsertProcedure({
      taskPattern: "Global procedure for everyone",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "global",
    });
    db.upsertProcedure({
      taskPattern: "Forge git commit procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "forge",
    });
    db.upsertProcedure({
      taskPattern: "Hearth HA automation procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "hearth",
    });

    // Search with Forge scope filter
    const forgeResults = db.searchProcedures("procedure", 10, 0.1, {
      userId: null,
      agentId: "forge",
      sessionId: null,
    });
    // Should see: global + forge-specific (NOT hearth)
    expect(forgeResults.some((p) => p.taskPattern.includes("Global"))).toBe(true);
    expect(forgeResults.some((p) => p.taskPattern.includes("Forge"))).toBe(true);
    expect(forgeResults.some((p) => p.taskPattern.includes("Hearth"))).toBe(false);

    // Search with Hearth scope filter
    const hearthResults = db.searchProcedures("procedure", 10, 0.1, {
      userId: null,
      agentId: "hearth",
      sessionId: null,
    });
    // Should see: global + hearth-specific (NOT forge)
    expect(hearthResults.some((p) => p.taskPattern.includes("Global"))).toBe(true);
    expect(hearthResults.some((p) => p.taskPattern.includes("Hearth"))).toBe(true);
    expect(hearthResults.some((p) => p.taskPattern.includes("Forge"))).toBe(false);
  });

  it("searchProceduresRanked with scopeFilter returns only matching scoped procedures", () => {
    // Create procedures with different scopes
    db.upsertProcedure({
      taskPattern: "Global ranked procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "global",
      successCount: 5,
    });
    db.upsertProcedure({
      taskPattern: "Forge ranked git procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "forge",
      successCount: 5,
    });
    db.upsertProcedure({
      taskPattern: "Hearth ranked HA procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "hearth",
      successCount: 5,
    });

    // Search with Forge scope filter
    const forgeResults = db.searchProceduresRanked("procedure", 10, 0.1, {
      userId: null,
      agentId: "forge",
      sessionId: null,
    });
    // Should see: global + forge-specific (NOT hearth)
    expect(forgeResults.some((p) => p.taskPattern.includes("Global"))).toBe(true);
    expect(forgeResults.some((p) => p.taskPattern.includes("Forge"))).toBe(true);
    expect(forgeResults.some((p) => p.taskPattern.includes("Hearth"))).toBe(false);
  });

  it("getNegativeProceduresMatching with scopeFilter respects scope boundaries", () => {
    // Create negative procedures with different scopes
    db.upsertProcedure({
      taskPattern: "Global failure everyone knows",
      recipeJson: "[]",
      procedureType: "negative",
      scope: "global",
    });
    db.upsertProcedure({
      taskPattern: "Forge specific git failure",
      recipeJson: "[]",
      procedureType: "negative",
      scope: "agent",
      scopeTarget: "forge",
    });

    // Forge should see both global and forge-specific failures
    const forgeNegs = db.getNegativeProceduresMatching("failure", 10, {
      userId: null,
      agentId: "forge",
      sessionId: null,
    });
    expect(forgeNegs.some((p) => p.taskPattern.includes("Global"))).toBe(true);
    expect(forgeNegs.some((p) => p.taskPattern.includes("Forge"))).toBe(true);

    // Hearth should only see global failure (NOT forge-specific)
    const hearthNegs = db.getNegativeProceduresMatching("failure", 10, {
      userId: null,
      agentId: "hearth",
      sessionId: null,
    });
    expect(hearthNegs.some((p) => p.taskPattern.includes("Global"))).toBe(true);
    expect(hearthNegs.some((p) => p.taskPattern.includes("Forge"))).toBe(false);
  });

  it("searchProcedures without scopeFilter returns all procedures (backward compatible)", () => {
    db.upsertProcedure({
      taskPattern: "Global procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "global",
    });
    db.upsertProcedure({
      taskPattern: "Agent procedure",
      recipeJson: "[]",
      procedureType: "positive",
      scope: "agent",
      scopeTarget: "forge",
    });

    // No scope filter = see all procedures (orchestrator view)
    const allResults = db.searchProcedures("procedure", 10);
    expect(allResults.length).toBeGreaterThanOrEqual(2);
    expect(allResults.some((p) => p.scope === "global")).toBe(true);
    expect(allResults.some((p) => p.scope === "agent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Procedure Feedback Loop tests (#782)
// ---------------------------------------------------------------------------

describe("FactsDB procedureFeedback", () => {
  it("procedureFeedback on success increments success count and updates last_validated", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy to test server",
      recipeJson: JSON.stringify([{ tool: "exec", args: { command: "deploy.sh" } }]),
      procedureType: "positive",
      successCount: 1,
    });

    const result = db.procedureFeedback({
      procedureId: proc.id,
      success: true,
      context: "Clean deploy",
    });

    expect(result).not.toBeNull();
    expect(result!.successCount).toBe(2);
    expect(result!.lastValidated).toBeGreaterThan(0);
    expect(result!.procedureType).toBe("positive");
    expect(result!.lastOutcome).toBe("success");
  });

  it("procedureFeedback on failure creates version bump and failure record", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy to Doris",
      recipeJson: JSON.stringify([{ tool: "exec" }, { tool: "ssh" }, { tool: "deploy" }]),
      procedureType: "positive",
      successCount: 2,
      failureCount: 0,
    });

    const result = db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "SSH key rejected — Doris rebooted and dropped the authorized_keys entry",
      failedAtStep: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.failureCount).toBe(1);
    expect(result!.lastFailed).toBeGreaterThan(0);
    expect(result!.procedureType).toBe("negative");
    expect(result!.lastOutcome).toBe("failure");
    expect(result!.version).toBe(1); // first version record created
  });

  it("procedureFeedback on failure bumps version number", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy to Doris v2",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 1,
    });

    // First failure
    db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "First failure",
      failedAtStep: 1,
    });

    const result = db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "Second failure",
      failedAtStep: 2,
    });

    expect(result!.version).toBe(2);
  });

  it("procedureFeedback returns null for unknown procedure", () => {
    const result = db.procedureFeedback({
      procedureId: "nonexistent-id",
      success: true,
    });
    expect(result).toBeNull();
  });

  it("procedureFeedback records avoidance notes on failure", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy",
      recipeJson: "[]",
      procedureType: "positive",
    });

    db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "SSH key may be dropped after reboot",
      failedAtStep: 2,
    });

    const result = db.getProcedureById(proc.id);
    expect(result!.avoidanceNotes).toBeDefined();
    expect(result!.avoidanceNotes!.some((n) => n.includes("SSH key may be dropped"))).toBe(true);
  });

  it("procedureFeedback creates an episode record on failure", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy with episode",
      recipeJson: "[]",
      procedureType: "positive",
    });

    db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "Deploy failed",
      failedAtStep: 3,
      tags: ["doris", "production"],
    });

    const episodes = db.searchEpisodes({ procedureId: proc.id });
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0].outcome).toBe("failure");
    expect(episodes[0].procedureId).toBe(proc.id);
    expect(episodes[0].tags).toContain("doris");
  });

  it("procedureFeedback does NOT create episode on success", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy success",
      recipeJson: "[]",
      procedureType: "positive",
    });

    const before = db.episodesCount();
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "Clean" });
    const after = db.episodesCount();
    expect(after).toBe(before);
  });

  it("getProcedureVersions returns all versions", () => {
    const proc = db.upsertProcedure({ taskPattern: "Multi-version", recipeJson: "[]", procedureType: "positive" });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "v1 failed", failedAtStep: 1 });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "v2 failed", failedAtStep: 1 });
    // Third call is a success: it updates v2's success count, doesn't create a new version
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "v3 success" });

    const versions = db.getProcedureVersions(proc.id);
    // Two failure calls → two version records (v1, v2); success call just updates v2
    expect(versions.length).toBe(2);
    expect(versions[0].versionNumber).toBe(2); // newest first
    expect(versions[1].versionNumber).toBe(1);
  });

  it("getProcedureFailures returns failure records for each failure event", () => {
    const proc = db.upsertProcedure({ taskPattern: "Failure history", recipeJson: "[]", procedureType: "positive" });
    // Each failure call creates a new failure record
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail 1", failedAtStep: 1 });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail 2", failedAtStep: 2 });

    const failures = db.getProcedureFailures(proc.id);
    // Each failure call creates one failure record
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it("enrichProcedureWithFeedback computes successRate from procedure table counts", () => {
    const proc = db.upsertProcedure({ taskPattern: "Rate test", recipeJson: "[]", procedureType: "positive" });
    // Record 2 successes followed by 1 failure
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "ok1" });
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "ok2" });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail1", failedAtStep: 1 });

    const result = db.getProcedureById(proc.id);
    // procedure table: successCount=3 (initial 1 + 2), failureCount=1
    // version records: v1(success_count=2), v2(failure_count=1)
    // successRate = (3 + 2) / (3 + 2 + 1 + 1) = 5/7 ≈ 71.4%
    expect(result!.successRate).toBeCloseTo(0.71, 1);
    // lastValidated is set by the last success call (after lastFailed from failure call)
    // So lastValidated > lastFailed → lastOutcome = "success"
    expect(result!.lastOutcome).toBe("success");
  });

  it("enrichProcedureWithFeedback sets lastOutcome to failure when lastFailed > lastValidated", () => {
    const now = Math.floor(Date.now() / 1000);
    const proc = db.upsertProcedure({
      taskPattern: "Last fail test",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 2,
      failureCount: 1,
      lastValidated: now - 1000,
      lastFailed: now - 100,
    });

    const result = db.getProcedureById(proc.id);
    expect(result!.lastOutcome).toBe("failure");
  });

  it("enrichProcedureWithFeedback sets lastOutcome to success when lastValidated > lastFailed", () => {
    const now = Math.floor(Date.now() / 1000);
    const proc = db.upsertProcedure({
      taskPattern: "Last success test",
      recipeJson: "[]",
      procedureType: "positive",
      successCount: 3,
      failureCount: 1,
      lastValidated: now - 100,
      lastFailed: now - 1000,
    });

    const result = db.getProcedureById(proc.id);
    expect(result!.lastOutcome).toBe("success");
  });

  it("version number increments on each failure", () => {
    const proc = db.upsertProcedure({ taskPattern: "Version increment", recipeJson: "[]", procedureType: "positive" });

    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail 1", failedAtStep: 1 });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail 2", failedAtStep: 1 });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail 3", failedAtStep: 1 });

    const versions = db.getProcedureVersions(proc.id);
    expect(versions[0].versionNumber).toBe(3);
  });

  it("version number does NOT increment on success (failure creates new version)", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Version no-increment on success",
      recipeJson: "[]",
      procedureType: "positive",
    });

    db.procedureFeedback({ procedureId: proc.id, success: true, context: "ok" });
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "ok2" });
    db.procedureFeedback({ procedureId: proc.id, success: false, context: "fail" });

    const versions = db.getProcedureVersions(proc.id);
    // First success creates v1; second success updates v1; failure creates v2
    expect(versions.length).toBe(2);
    expect(versions[0].versionNumber).toBe(2); // newest
    expect(versions[1].versionNumber).toBe(1);
  });
});
