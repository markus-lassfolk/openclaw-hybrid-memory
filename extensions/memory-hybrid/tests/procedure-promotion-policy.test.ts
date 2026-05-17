import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  PROCEDURE_PROMOTION_POLICY_VERSION,
  ProcedurePromotionAdapter,
  createProcedurePromotionDecision,
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  parseProcedurePromotionPolicy,
} from "../services/procedure-promotion-policy.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
import { determineRiskLevel, parseRecipeOrRaw } from "../utils/procedure-risk.js";
import type { ProcedureEntry } from "../types/memory.js";
import { SKILL_COMPLETE_MARKER } from "../utils/atomic-write.js";
import { expectStandaloneAndParentDecisionsEquivalent } from "./helpers/pending-autopilot-equivalence.js";

let tmpDir: string;
let db: FactsDB;
let skillsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedure-promotion-policy-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
  skillsDir = join(tmpDir, "skills-auto");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function goodRecipe(extra: Record<string, unknown> = {}) {
  return JSON.stringify(
    [
      {
        tool: "read",
        args: { path: "status.json" },
        summary: "Check current status input",
      },
      {
        tool: "exec",
        args: { command: "npm test -- --runInBand" },
        summary: "Run validation test command",
      },
      {
        tool: "read",
        args: { path: "report.json" },
        summary: "Verify generated report exists",
      },
      extra,
    ].filter((x) => Object.keys(x).length > 0),
  );
}

type ProcedureInput = Parameters<FactsDB["upsertProcedure"]>[0];
function addProcedure(overrides: Partial<ProcedureInput> = {}) {
  return db.upsertProcedure({
    taskPattern: "Validate release health report with objective checks",
    recipeJson: goodRecipe(),
    procedureType: "positive",
    successCount: 5,
    failureCount: 0,
    confidence: 0.9,
    lastValidated: 1_700_000_000,
    sourceSessionId: "s1",
    ...(overrides as Partial<ProcedureInput>),
  } as ProcedureInput);
}

function requireProcedure(id: string): ProcedureEntry {
  const proc = db.getProcedureById(id);
  if (!proc) throw new Error(`Procedure not found in test fixture: ${id}`);
  return proc;
}

describe("procedure promotion policy and adapter", () => {
  it("dry-run does not write skills or mark procedures promoted", () => {
    const proc = addProcedure({ sourceSessionId: "s1" });
    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.dryRun).toBe(true);
    expect(result.summary?.eligible).toBe(1);
    expect(existsSync(skillsDir)).toBe(false);
    expect(db.getProcedureById(proc.id)?.promotedToSkill).toBe(0);
  });

  it("eligible successful procedure generates draft verified skill output with required structure and metadata", () => {
    const proc = addProcedure({ sourceSessionId: "s1" });
    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.summary).toMatchObject({
      candidates: 1,
      eligible: 1,
      drafted: 1,
      promoted: 0,
    });
    const skillPath = result.paths[0];
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(join(skillsDir, "validate-release-health-report-with-objective-checks", "recipe.json"))).toBe(
      true,
    );
    expect(
      existsSync(join(skillsDir, "validate-release-health-report-with-objective-checks", "verification.json")),
    ).toBe(true);
    expect(
      existsSync(join(skillsDir, "validate-release-health-report-with-objective-checks", "proposal-metadata.json")),
    ).toBe(true);
    expect(
      existsSync(join(skillsDir, "validate-release-health-report-with-objective-checks", "evals", "evals.json")),
    ).toBe(true);

    const skill = readFileSync(skillPath, "utf-8");
    for (const section of [
      "## When to Activate",
      "## Scope",
      "## Do Not Use When",
      "## Workflow",
      "## Safe tool usage",
      "## Verification",
      "## Failure handling",
      "## Rollback / disable guidance",
      "## Anti-patterns / Known Failures",
      "## Examples",
      "## Related tools/skills",
      "## Provenance",
    ]) {
      expect(skill).toContain(section);
    }
    const verification = JSON.parse(
      readFileSync(
        join(skillsDir, "validate-release-health-report-with-objective-checks", "verification.json"),
        "utf-8",
      ),
    );
    expect(verification).toMatchObject({
      enabled: false,
      staticValidation: "passed",
      safetyValidation: "passed",
      triggerEval: "passed",
      functionalEval: "passed",
      candidateScore: expect.any(Number),
      riskLevel: expect.stringMatching(/^(low|medium|high)$/),
    });
    expect(verification.sourceProcedureIds).toEqual([proc.id]);
  });

  it("includes negative evidence in anti-patterns when failures exist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const proc = addProcedure({ sourceSessionId: "s1" });
    db.recordProcedureSuccess(proc.id, undefined, "s2");
    db.recordProcedureSuccess(proc.id, undefined, "s3");

    vi.advanceTimersByTime(2000);
    db.procedureFeedback({
      procedureId: proc.id,
      success: false,
      context: "Command output was pasted verbatim; validation step was missing",
      failedAtStep: 2,
    });

    vi.advanceTimersByTime(2000);
    db.procedureFeedback({
      procedureId: proc.id,
      success: true,
      context: "Re-validated with objective checks",
    });
    // Version-tracked feedback yields successRate = successes / (successes + failures) across
    // procedure_versions. One failure + one success on the same version is 0.5 — below the
    // promotion policy minimum — so add two more successes to recover eligibility while
    // retaining the recorded avoidance note for anti-patterns.
    vi.advanceTimersByTime(2000);
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "Stable re-run A" });
    vi.advanceTimersByTime(2000);
    db.procedureFeedback({ procedureId: proc.id, success: true, context: "Stable re-run B" });

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    vi.useRealTimers();

    const skillPath = result.paths[0];
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain("## Anti-patterns / Known Failures");
    expect(skill).toMatch(/Known failure: v\d+ step 2:/);
    expect(skill).toContain("validation step was missing");
  });

  it("dry-run includes earlier same-run drafts when detecting duplicate skills", () => {
    const first = addProcedure({
      taskPattern: "Validate duplicate report workflow",
      sourceSessionId: "same-run-duplicate-a",
    });
    const second = addProcedure({
      taskPattern: "Validate duplicate report workflow",
      sourceSessionId: "same-run-duplicate-d",
    });
    for (const [proc, prefix] of [
      [first, "same-run-duplicate-a"],
      [second, "same-run-duplicate-d"],
    ] as const) {
      db.recordProcedureSuccess(proc.id, undefined, `${prefix}-b`);
      db.recordProcedureSuccess(proc.id, undefined, `${prefix}-c`);
    }

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(result.dryRun).toBe(true);
    expect(result.summary).toMatchObject({
      candidates: 2,
      eligible: 1,
      drafted: 1,
      deferred: 1,
    });
    expect(result.decisions?.find((d) => d.procedureId === first.id)?.action).toBe("promoted-to-draft");
    expect(result.decisions?.find((d) => d.procedureId === second.id)?.reasons).toContain("duplicate_existing_skill");
    expect(existsSync(skillsDir)).toBe(false);
  });

  it("compares duplicate skills against task-specific sections instead of template boilerplate", () => {
    const existingSkillDir = join(skillsDir, "collect-weather-sensor-status");
    mkdirSync(existingSkillDir, { recursive: true });
    writeFileSync(join(existingSkillDir, SKILL_COMPLETE_MARKER), new Date().toISOString(), "utf-8");
    writeFileSync(
      join(existingSkillDir, "SKILL.md"),
      `---
name: collect-weather-sensor-status
description: Use when the user asks to collect weather sensor status from telemetry.
---

# Collect Weather Sensor Status

## Trigger
Use for weather sensor telemetry collection.

## Workflow
1. Read status.json.
2. Verify report output exists.

## Validation
Confirm report output exists and validation passes.

## Failure handling
Report failures instead of improvising.

## Provenance
Source procedure id: proc-weather
`,
      "utf-8",
    );
    const distinctReportProc = addProcedure({
      taskPattern: "Validate release health report with objective checks",
      sourceSessionId: "boilerplate-overlap-a",
    });
    db.recordProcedureSuccess(distinctReportProc.id, undefined, "boilerplate-overlap-b");
    db.recordProcedureSuccess(distinctReportProc.id, undefined, "boilerplate-overlap-c");
    const duplicateWeatherProc = addProcedure({
      taskPattern: "Collect weather sensor telemetry status",
      sourceSessionId: "task-overlap-a",
    });
    db.recordProcedureSuccess(duplicateWeatherProc.id, undefined, "task-overlap-b");
    db.recordProcedureSuccess(duplicateWeatherProc.id, undefined, "task-overlap-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const distinctEval = evaluateProcedureForPromotion(
      createProcedurePromotionItem(distinctReportProc, policy),
      policy,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
      },
    );
    const duplicateEval = evaluateProcedureForPromotion(
      createProcedurePromotionItem(duplicateWeatherProc, policy),
      policy,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
      },
    );

    expect(distinctEval.metadata.rejectionReasons).not.toContain("duplicate_existing_skill");
    expect(duplicateEval.metadata.rejectionReasons).toContain("duplicate_existing_skill");
  });

  it("ignores leftover atomic temp directories when checking duplicates", () => {
    const tempSkillDir = join(skillsDir, ".openclaw-skill-tmp-1234-deadbeef");
    mkdirSync(tempSkillDir, { recursive: true });
    writeFileSync(
      join(tempSkillDir, "SKILL.md"),
      `---
name: validate-release-health-report-with-objective-checks
description: Use when the user asks to validate release health report with objective checks.
---
`,
      "utf-8",
    );

    const proc = addProcedure({ sourceSessionId: "temp-dir-overlap-a" });
    db.recordProcedureSuccess(proc.id, undefined, "temp-dir-overlap-b");
    db.recordProcedureSuccess(proc.id, undefined, "temp-dir-overlap-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const evaluation = evaluateProcedureForPromotion(createProcedurePromotionItem(proc, policy), policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });

    expect(evaluation.metadata.rejectionReasons).not.toContain("duplicate_existing_skill");
  });

  it("treats legacy skill directories without completion markers as duplicate skills", () => {
    const existingSkillDir = join(skillsDir, "collect-markerless-legacy-report");
    mkdirSync(existingSkillDir, { recursive: true });
    writeFileSync(
      join(existingSkillDir, "SKILL.md"),
      `---
name: collect-markerless-legacy-report
description: Use when collecting markerless legacy reports.
---

# Collect Markerless Legacy Report

## Trigger
Use for collecting markerless legacy reports.

## Workflow
1. Read status.json.
2. Verify report output exists.
`,
      "utf-8",
    );

    const proc = addProcedure({
      taskPattern: "Collect markerless legacy report",
      sourceSessionId: "markerless-legacy-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "markerless-legacy-b");
    db.recordProcedureSuccess(proc.id, undefined, "markerless-legacy-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const evaluation = evaluateProcedureForPromotion(createProcedurePromotionItem(proc, policy), policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });

    expect(evaluation.metadata.rejectionReasons).toContain("duplicate_existing_skill");
    expect(evaluation.metadata.duplicateHandling).toBe("merge");
  });

  it("does not report generated skill paths for deferred procedures", () => {
    const proc = addProcedure({
      taskPattern: "Validate deferred low confidence report",
      recipeJson: goodRecipe(),
      confidence: 0.1,
      sourceSessionId: "generated-path-deferred-a",
    });
    const item = createProcedurePromotionItem(requireProcedure(proc.id), "auto-safe");

    const evaluation = evaluateProcedureForPromotion(item, "auto-safe", {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
      minDistinctContexts: 1,
    });

    expect(evaluation.eligible).toBe(false);
    expect(evaluation.metadata.rejectionReasons).toContain("low_confidence");
    expect(evaluation.metadata.promotionDecision).toBe("deferred");
    expect(evaluation.draft).toBeNull();
    expect(evaluation.metadata.generatedSkillPath).toBeNull();
  });

  it("scores candidates using success/failure outcomes and duplicate-skill evidence", () => {
    const proc = addProcedure({
      taskPattern: "Validate scoring workflow with objective checks",
      sourceSessionId: "score-a",
      successCount: 6,
      failureCount: 0,
      confidence: 0.92,
    });
    db.recordProcedureSuccess(proc.id, undefined, "score-b");
    db.recordProcedureSuccess(proc.id, undefined, "score-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const baseOptions = {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    };
    const successfulOnly = evaluateProcedureForPromotion(item, policy, {
      ...baseOptions,
      evidence: {
        procedureVersions: [
          {
            id: "version-success-1",
            versionNumber: 1,
            successCount: 6,
            failureCount: 0,
            avoidanceNotes: null,
            createdAt: 1_700_000_001,
          },
        ],
        episodes: [{ id: "episode-success-1", outcome: "success", sessionId: "score-a" }],
        manualWorkflowRequests: [{ id: "manual-request-1", sourceSession: "score-a" }],
      },
    });
    const failureHeavy = evaluateProcedureForPromotion(item, policy, {
      ...baseOptions,
      evidence: {
        procedureVersions: [
          {
            id: "version-fail-1",
            versionNumber: 1,
            successCount: 2,
            failureCount: 7,
            avoidanceNotes: ["step 2 failed repeatedly"],
            createdAt: 1_700_000_001,
          },
        ],
        procedureFailures: [
          {
            id: "failure-1",
            versionNumber: 1,
            timestamp: 1_700_000_100,
            context: "timeout",
            failedAtStep: 2,
          },
          {
            id: "failure-2",
            versionNumber: 1,
            timestamp: 1_700_000_200,
            context: "bad output",
            failedAtStep: 3,
          },
        ],
        episodes: [
          { id: "episode-failure-1", outcome: "failure", sessionId: "score-a" },
          { id: "episode-failure-2", outcome: "failure", sessionId: "score-b" },
          { id: "episode-partial-1", outcome: "partial", sessionId: "score-c" },
        ],
        userCorrections: [{ id: "correction-1", sourceSession: "score-a" }],
      },
    });
    const duplicateSkill = evaluateProcedureForPromotion(item, policy, {
      ...baseOptions,
      inRunSkillCandidates: [{ slug: item.payload.skillSlug, taskPattern: proc.taskPattern }],
      evidence: {
        procedureVersions: [
          {
            id: "version-success-2",
            versionNumber: 2,
            successCount: 6,
            failureCount: 0,
            avoidanceNotes: null,
            createdAt: 1_700_000_300,
          },
        ],
      },
    });

    expect(successfulOnly.metadata.candidateScore).toBeGreaterThan(failureHeavy.metadata.candidateScore);
    expect(duplicateSkill.metadata.candidateScore).toBeLessThan(successfulOnly.metadata.candidateScore);
    expect(failureHeavy.metadata.sourceFailureCount).toBeGreaterThan(failureHeavy.metadata.sourceSuccessCount);
    expect(duplicateSkill.metadata.rejectionReasons).toContain("duplicate_existing_skill");
    expect(duplicateSkill.metadata.duplicateHandling).toBe("merge");
  });

  it("rejects or defers low-value noisy, recent-failure, low-confidence, destructive, external, duplicate, and malformed recipes", () => {
    const cases = [
      {
        reason: "low_reuse_value",
        proc: addProcedure({
          taskPattern: "Do check",
          recipeJson: JSON.stringify([{ tool: "read", summary: "check" }]),
          sourceSessionId: "a",
        }),
      },
      {
        reason: "recent_failure",
        proc: addProcedure({
          taskPattern: "Validate failed report workflow",
          lastValidated: 1_700_000_000,
          lastFailed: Math.floor(Date.now() / 1000),
          sourceSessionId: "b",
        }),
      },
      {
        reason: "low_confidence",
        proc: addProcedure({
          taskPattern: "Validate low confidence report workflow",
          confidence: 0.2,
          successCount: 3,
          sourceSessionId: "c",
        }),
      },
      {
        reason: "unsafe_side_effect",
        proc: addProcedure({
          taskPattern: "Validate destructive cleanup workflow",
          recipeJson: JSON.stringify([
            {
              tool: "exec",
              args: { command: "rm -rf /tmp/x" },
              summary: "delete",
            },
            {
              tool: "exec",
              args: { command: "echo verify" },
              summary: "verify",
            },
          ]),
          sourceSessionId: "d",
        }),
      },
      {
        reason: "credential_risk",
        proc: addProcedure({
          taskPattern: "Validate token handling workflow",
          recipeJson: JSON.stringify([
            {
              tool: "exec",
              args: { command: "echo token=ghp_123456789abcdef" },
              summary: "print token",
            },
            {
              tool: "exec",
              args: { command: "echo verify" },
              summary: "verify",
            },
          ]),
          sourceSessionId: "e",
        }),
      },
      {
        reason: "external_side_effect_requires_approval",
        proc: addProcedure({
          taskPattern: "Validate outbound notification workflow",
          recipeJson: JSON.stringify([
            { tool: "message", args: { text: "send update" }, summary: "send" },
            {
              tool: "exec",
              args: { command: "echo verify" },
              summary: "verify",
            },
          ]),
          sourceSessionId: "f",
        }),
      },
      {
        reason: "malformed_recipe",
        proc: addProcedure({
          taskPattern: "Validate malformed report workflow",
          recipeJson: "not-json",
          sourceSessionId: "g",
        }),
      },
    ];
    for (const c of cases) {
      db.recordProcedureSuccess(c.proc.id, undefined, `${c.reason}-second-session`);
      db.recordProcedureSuccess(c.proc.id, undefined, `${c.reason}-third-session`);
    }

    // Existing skill collision.
    const dup = addProcedure({
      taskPattern: "Validate duplicate report workflow",
      sourceSessionId: "h",
    });
    db.recordProcedureSuccess(dup.id, undefined, "h2");
    db.recordProcedureSuccess(dup.id, undefined, "h3");
    generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 1,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );
    const dup2 = addProcedure({
      taskPattern: "Validate duplicate report workflow",
      sourceSessionId: "i",
    });
    db.recordProcedureSuccess(dup2.id, undefined, "i2");
    db.recordProcedureSuccess(dup2.id, undefined, "i3");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 50,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );
    const lowConfidenceItem = createProcedurePromotionItem(cases[2].proc, parseProcedurePromotionPolicy("auto-safe"));
    const lowConfidenceEval = evaluateProcedureForPromotion(
      lowConfidenceItem,
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );
    expect(lowConfidenceEval.metadata.rejectionReasons).toContain("low_confidence");
    const externalItem = createProcedurePromotionItem(cases[5].proc, parseProcedurePromotionPolicy("auto-safe"));
    const externalEval = evaluateProcedureForPromotion(externalItem, parseProcedurePromotionPolicy("auto-safe"), {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    expect(externalEval.metadata.rejectionReasons).toContain("external_side_effect_requires_approval");
    const allReasons = result.decisions?.flatMap((d) => d.reasons) ?? [];
    const duplicateItem = createProcedurePromotionItem(dup2, parseProcedurePromotionPolicy("auto-safe"));
    const duplicateEval = evaluateProcedureForPromotion(duplicateItem, parseProcedurePromotionPolicy("auto-safe"), {
      skillsAutoPath: skillsDir,
      existingSkillDirs: [skillsDir],
      validationThreshold: 3,
    });
    expect(
      ["duplicate_existing_skill", "insufficient_distinct_contexts"].some((r) =>
        duplicateEval.metadata.rejectionReasons.includes(r as never),
      ),
    ).toBe(true);
    for (const expected of cases
      .map((c) => c.reason)
      .filter((r) => r !== "low_confidence" && r !== "external_side_effect_requires_approval")) {
      expect(allReasons, `missing ${expected}; got ${allReasons.join(",")}`).toContain(expected);
    }
  });

  it("flags generic context-specific wording without hard-coded personal names", () => {
    const localProcedure = addProcedure({
      taskPattern: "Validate household dashboard report",
      sourceSessionId: "context-specific-a",
    });
    db.recordProcedureSuccess(localProcedure.id, undefined, "context-specific-b");
    db.recordProcedureSuccess(localProcedure.id, undefined, "context-specific-c");
    const localEval = evaluateProcedureForPromotion(
      createProcedurePromotionItem(localProcedure, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(localEval.metadata.rejectionReasons).toContain("too_context_specific");

    const reusableProcedure = addProcedure({
      taskPattern: "Validate named customer release report",
      sourceSessionId: "named-customer-a",
    });
    db.recordProcedureSuccess(reusableProcedure.id, undefined, "named-customer-b");
    db.recordProcedureSuccess(reusableProcedure.id, undefined, "named-customer-c");
    const reusableEval = evaluateProcedureForPromotion(
      createProcedurePromotionItem(reusableProcedure, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(reusableEval.metadata.rejectionReasons).not.toContain("too_context_specific");
  });

  it("does not treat recipe paths or private boolean fields as context-specific wording", () => {
    const proc = addProcedure({
      taskPattern: "Validate reusable release report workflow",
      recipeJson: JSON.stringify([
        {
          tool: "read",
          args: { path: "/home/alice/status.json", private: true },
          summary: "Check status input",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Verify report output",
        },
      ]),
      sourceSessionId: "recipe-private-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "recipe-private-b");
    db.recordProcedureSuccess(proc.id, undefined, "recipe-private-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).toContain("private_data_risk");
    expect(evaluation.metadata.rejectionReasons).not.toContain("too_context_specific");
  });

  it("requires an explicit recipe validation step instead of task wording alone", () => {
    const proc = addProcedure({
      taskPattern: "Check release report status",
      recipeJson: JSON.stringify([
        {
          tool: "read",
          args: { path: "status.json" },
          summary: "Read status input",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Open report output",
        },
      ]),
      sourceSessionId: "no-validation-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "no-validation-b");
    db.recordProcedureSuccess(proc.id, undefined, "no-validation-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).toContain("no_validation_possible");
  });

  it("blocks private/high-entropy data and redacts generated artifacts", () => {
    const proc = addProcedure({
      taskPattern: "Validate private report workflow",
      recipeJson: JSON.stringify([
        {
          tool: "read",
          args: { path: "/home/alice/private/status.json" },
          summary: "read private path",
        },
        { tool: "exec", args: { command: "echo verify" }, summary: "verify" },
      ]),
      sourceSessionId: "private-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "private-b");
    db.recordProcedureSuccess(proc.id, undefined, "private-c");

    const result = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        dryRun: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );
    expect(result.decisions?.find((d) => d.procedureId === proc.id)?.reasons).toContain("private_data_risk");
    expect(existsSync(skillsDir)).toBe(false);
  });

  it("unverified skills are never enabled and idempotent rerun avoids duplicate promotion churn", () => {
    const proc = addProcedure({ sourceSessionId: "idem-a" });
    db.recordProcedureSuccess(proc.id, undefined, "idem-b");
    db.recordProcedureSuccess(proc.id, undefined, "idem-c");

    const first = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );
    const second = generateAutoSkills(
      db,
      {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        apply: true,
        policy: "auto-safe",
        maxPerRun: 10,
        skillTTLDays: 30,
      },
      { info: () => {}, warn: () => {} },
    );

    expect(first.decisions?.[0]?.enabled).toBe(false);
    expect(second.summary?.candidates).toBe(0);
    expect(db.getProcedureById(proc.id)?.promotedToSkill).toBe(1);
  });

  it("decision semantics defer eligible draft-only/manual candidates for human review", () => {
    const proc = addProcedure({ sourceSessionId: "decision-policy-a" });
    db.recordProcedureSuccess(proc.id, undefined, "decision-policy-b");
    db.recordProcedureSuccess(proc.id, undefined, "decision-policy-c");
    const policy = parseProcedurePromotionPolicy("draft-only");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    const decision = createProcedurePromotionDecision(
      item,
      {
        runId: "run-decision-1",
        mode: "apply",
        policy,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        inputHash: item.inputHash,
        actor: { type: "test", id: "procedure-policy-test" },
      },
      evaluation,
    );

    expect(decision.action).toBe("deferred-for-human");
    expect(decision.reasonCode).toBe("human-review-required");
    expect(decision.capabilityClass).toBe("record-review-metadata");
    expect(decision.humanReviewRequired).toBe(true);
  });

  it("decision semantics allow auto-safe promotion without human-review reason", () => {
    const proc = addProcedure({ sourceSessionId: "decision-auto-safe-a" });
    db.recordProcedureSuccess(proc.id, undefined, "decision-auto-safe-b");
    db.recordProcedureSuccess(proc.id, undefined, "decision-auto-safe-c");
    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    const decision = createProcedurePromotionDecision(
      item,
      {
        runId: "run-decision-2",
        mode: "apply",
        policy,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        inputHash: item.inputHash,
        actor: { type: "test", id: "procedure-policy-test" },
      },
      evaluation,
    );

    expect(decision.action).toBe("promoted-to-draft");
    expect(decision.capabilityClass).toBe("write-draft-artifact");
    expect(decision.reasonCode).not.toBe("human-review-required");
    expect(decision.humanReviewRequired).toBe(false);
  });

  it("classifies non-eligible actions from the highest-severity gate, not gate order", () => {
    const proc = addProcedure({
      taskPattern: "Validate low confidence credential workflow",
      confidence: 0.2,
      recipeJson: JSON.stringify([
        {
          tool: "exec",
          args: { command: "echo token=ghp_123456789abcdef" },
          summary: "echo credential-like token",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run validation test",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Verify report output",
        },
      ]),
      sourceSessionId: "severity-a",
    });
    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    const decision = createProcedurePromotionDecision(
      item,
      {
        runId: "run-decision-severity",
        mode: "apply",
        policy,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        inputHash: item.inputHash,
        actor: { type: "test", id: "procedure-policy-test" },
      },
      evaluation,
    );

    expect(evaluation.metadata.rejectionReasons).toContain("low_confidence");
    expect(evaluation.metadata.rejectionReasons).toContain("credential_risk");
    expect(decision.action).toBe("rejected");
    expect(decision.reasonCode).toBe("policy-denied");
  });

  it("maps non-schema validation gates to policy threshold instead of schema validation failure", () => {
    const proc = addProcedure({
      taskPattern: "Validate workflow that still lacks explicit checks",
      recipeJson: JSON.stringify([
        {
          tool: "read",
          args: { path: "status.json" },
          summary: "Check status input",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Review report output",
        },
      ]),
      sourceSessionId: "no-validation-reason-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "no-validation-reason-b");
    db.recordProcedureSuccess(proc.id, undefined, "no-validation-reason-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    const decision = createProcedurePromotionDecision(
      item,
      {
        runId: "run-decision-non-schema-validation",
        mode: "apply",
        policy,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        inputHash: item.inputHash,
        actor: { type: "test", id: "procedure-policy-test" },
      },
      evaluation,
    );

    expect(evaluation.metadata.rejectionReasons).toContain("no_validation_possible");
    expect(decision.action).toBe("deferred-for-human");
    expect(decision.reasonCode).toBe("policy-threshold-not-met");
  });

  it("records collision-resolved slug in evaluation metadata", () => {
    const proc = addProcedure({ sourceSessionId: "resolved-slug-a" });
    db.recordProcedureSuccess(proc.id, undefined, "resolved-slug-b");
    db.recordProcedureSuccess(proc.id, undefined, "resolved-slug-c");

    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
      resolvedSlug: "validate-release-health-report-with-objective-checks-1",
    });
    const decision = createProcedurePromotionDecision(
      item,
      {
        runId: "run-decision-resolved-slug",
        mode: "apply",
        policy,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        inputHash: item.inputHash,
        actor: { type: "test", id: "procedure-policy-test" },
      },
      evaluation,
    );

    expect(evaluation.metadata).toMatchObject({
      skill: "validate-release-health-report-with-objective-checks-1",
      generatedSkillPath: join(skillsDir, "validate-release-health-report-with-objective-checks-1"),
    });
    expect(decision.summary?.body).toContain("validate-release-health-report-with-objective-checks-1");
  });

  it("defers tasks with only vague filler wording even when word count is high", () => {
    const proc = addProcedure({
      taskPattern: "Do stuff things quickly",
      sourceSessionId: "vague-task-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "vague-task-b");
    db.recordProcedureSuccess(proc.id, undefined, "vague-task-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).toContain("vague_trigger");
  });

  it("standalone and parent adapter route produce equivalent decisions", async () => {
    const proc = addProcedure({ sourceSessionId: "eq-a" });
    db.recordProcedureSuccess(proc.id, undefined, "eq-b");
    db.recordProcedureSuccess(proc.id, undefined, "eq-c");
    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const fixedNow = 1_800_000_000;
    const adapter = new ProcedurePromotionAdapter([requireProcedure(proc.id)], policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
      now: fixedNow,
    });
    const [listed] = adapter.listPending();

    await expectStandaloneAndParentDecisionsEquivalent({
      fixtures: [{ item, policy, policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION }],
      standalone: (fixture, context) => adapter.decide(fixture, context),
      parent: (_fixture, context) => adapter.decide(listed, context),
    });
  });

  describe("procedure scoring and risk-aware policy (#1414)", () => {
    it("userSignal separates no user evidence from one manual request plus one correction", () => {
      const proc = addProcedure({
        sourceSessionId: "usig-a",
        successCount: 6,
        failureCount: 0,
        confidence: 0.92,
      });
      db.recordProcedureSuccess(proc.id, undefined, "usig-b");
      db.recordProcedureSuccess(proc.id, undefined, "usig-c");
      const policy = parseProcedurePromotionPolicy("auto-safe");
      const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
      const baseOpts = {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        minDistinctContexts: 1,
      };
      const none = evaluateProcedureForPromotion(item, policy, { ...baseOpts, evidence: {} });
      const mixed = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: {
          manualWorkflowRequests: [{ id: "m1", sourceSession: "usig-a" }],
          userCorrections: [{ id: "c1", sourceSession: "usig-a" }],
        },
      });
      expect(none.metadata.candidateScoreBreakdown.userSignal).toBeGreaterThan(
        mixed.metadata.candidateScoreBreakdown.userSignal,
      );
    });

    it("userSignal is monotone: more manual requests increases score; more corrections decreases it", () => {
      const proc = addProcedure({
        taskPattern: "Validate monotone user signal scoring workflow",
        sourceSessionId: "mono-a",
        successCount: 6,
        failureCount: 0,
        confidence: 0.92,
      });
      db.recordProcedureSuccess(proc.id, undefined, "mono-b");
      db.recordProcedureSuccess(proc.id, undefined, "mono-c");
      const policy = parseProcedurePromotionPolicy("auto-safe");
      const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
      const baseOpts = {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        minDistinctContexts: 1,
      };
      const baseline = evaluateProcedureForPromotion(item, policy, { ...baseOpts, evidence: {} });
      const oneManual = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { manualWorkflowRequests: [{ id: "m1" }] },
      });
      const twoManual = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { manualWorkflowRequests: [{ id: "m1" }, { id: "m2" }] },
      });
      expect(oneManual.metadata.candidateScoreBreakdown.userSignal).toBeGreaterThan(
        baseline.metadata.candidateScoreBreakdown.userSignal,
      );
      expect(twoManual.metadata.candidateScoreBreakdown.userSignal).toBeGreaterThan(
        oneManual.metadata.candidateScoreBreakdown.userSignal,
      );

      const oneCorrection = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { userCorrections: [{ id: "c1" }] },
      });
      const twoCorrections = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { userCorrections: [{ id: "c1" }, { id: "c2" }] },
      });
      expect(oneCorrection.metadata.candidateScoreBreakdown.userSignal).toBeLessThan(
        baseline.metadata.candidateScoreBreakdown.userSignal,
      );
      expect(twoCorrections.metadata.candidateScoreBreakdown.userSignal).toBeLessThan(
        oneCorrection.metadata.candidateScoreBreakdown.userSignal,
      );
    });

    it("caps rules-and-preferences contribution so repeated rules do not dominate userSignal", () => {
      const proc = addProcedure({
        taskPattern: "Validate rules cap user signal scoring workflow",
        sourceSessionId: "cap-a",
        successCount: 6,
        failureCount: 0,
        confidence: 0.92,
      });
      db.recordProcedureSuccess(proc.id, undefined, "cap-b");
      db.recordProcedureSuccess(proc.id, undefined, "cap-c");
      const policy = parseProcedurePromotionPolicy("auto-safe");
      const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
      const baseOpts = {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        minDistinctContexts: 1,
      };
      const manyRules = Array.from({ length: 12 }, (_, i) => ({ id: `rule-${i}` }));
      const fiveRules = manyRules.slice(0, 5);
      const capped = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { rulesAndPreferences: fiveRules },
      });
      const uncappedWouldDiffer = evaluateProcedureForPromotion(item, policy, {
        ...baseOpts,
        evidence: { rulesAndPreferences: manyRules },
      });
      expect(uncappedWouldDiffer.metadata.candidateScoreBreakdown.userSignal).toBe(
        capped.metadata.candidateScoreBreakdown.userSignal,
      );
    });

    it("classifies risk with the same command variants covered by safety scanning", () => {
      const base = requireProcedure(addProcedure({ taskPattern: "Validate procedure risk classifier variants" }).id);
      const mediumRecipes = [
        JSON.stringify([{ tool: "exec", args: { command: "fetch https://api.example.com -X POST" } }]),
        JSON.stringify([{ tool: "exec", args: { command: "pip3 install example-package" } }]),
        JSON.stringify([{ tool: "exec", args: { command: "apt-get upgrade example-package" } }]),
      ];

      for (const recipeJson of mediumRecipes) {
        expect(determineRiskLevel(base, parseRecipeOrRaw(recipeJson))).toBe("medium");
      }
    });

    it("ranks low-risk candidates above high-risk with otherwise similar promotion evidence", () => {
      const lowProc = addProcedure({
        taskPattern: "Validate low risk ranking workflow with objective checks",
        recipeJson: goodRecipe(),
        sourceSessionId: "rank-low-a",
        successCount: 6,
        failureCount: 0,
        confidence: 0.92,
      });
      db.recordProcedureSuccess(lowProc.id, undefined, "rank-low-b");
      db.recordProcedureSuccess(lowProc.id, undefined, "rank-low-c");

      const highProc = addProcedure({
        taskPattern: "Validate high risk ranking workflow with objective checks",
        recipeJson: JSON.stringify([
          {
            tool: "exec",
            args: { command: "rm -rf /tmp/x" },
            summary: "delete temp",
          },
          {
            tool: "exec",
            args: { command: "npm test -- --runInBand" },
            summary: "Run validation test command",
          },
          {
            tool: "read",
            args: { path: "report.json" },
            summary: "Verify generated report exists",
          },
        ]),
        sourceSessionId: "rank-high-a",
        successCount: 6,
        failureCount: 0,
        confidence: 0.92,
      });
      db.recordProcedureSuccess(highProc.id, undefined, "rank-high-b");
      db.recordProcedureSuccess(highProc.id, undefined, "rank-high-c");

      const policy = parseProcedurePromotionPolicy("auto-safe");
      const sharedEvidence = {
        procedureVersions: [
          {
            id: "v1",
            versionNumber: 1,
            successCount: 6,
            failureCount: 0,
            avoidanceNotes: null,
            createdAt: 1_700_000_001,
          },
        ],
        episodes: [{ id: "e1", outcome: "success" as const, sessionId: "s-shared" }],
      };
      const baseOpts = {
        skillsAutoPath: skillsDir,
        validationThreshold: 3,
        minDistinctContexts: 1,
        evidence: sharedEvidence,
      };

      const lowEval = evaluateProcedureForPromotion(
        createProcedurePromotionItem(requireProcedure(lowProc.id), policy),
        policy,
        baseOpts,
      );
      const highEval = evaluateProcedureForPromotion(
        createProcedurePromotionItem(requireProcedure(highProc.id), policy),
        policy,
        baseOpts,
      );

      expect(lowEval.metadata.riskLevel).toBe("low");
      expect(highEval.metadata.riskLevel).toBe("high");
      expect(lowEval.metadata.candidateScore).toBeGreaterThan(highEval.metadata.candidateScore);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #1385 — loopback (127.x) must NOT trigger private_data_risk
  // -------------------------------------------------------------------------

  it("does not flag loopback 127.0.0.1 as private_data_risk", () => {
    const proc = addProcedure({
      taskPattern: "Run health check on local development server",
      recipeJson: JSON.stringify([
        {
          tool: "exec",
          args: { command: "curl http://127.0.0.1:8080/health" },
          summary: "Ping local dev server health endpoint",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run test suite",
        },
        {
          tool: "read",
          args: { path: "test-report.json" },
          summary: "Verify test output",
        },
      ]),
      sourceSessionId: "loopback-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "loopback-b");
    db.recordProcedureSuccess(proc.id, undefined, "loopback-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).not.toContain("private_data_risk");
  });

  it("still flags RFC1918 address 192.168.x.x as private_data_risk", () => {
    const proc = addProcedure({
      taskPattern: "Connect to internal server for report",
      recipeJson: JSON.stringify([
        {
          tool: "exec",
          args: { command: "curl http://192.168.1.10/api/status" },
          summary: "Query internal server",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run test",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Read report",
        },
      ]),
      sourceSessionId: "rfc1918-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "rfc1918-b");
    db.recordProcedureSuccess(proc.id, undefined, "rfc1918-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).toContain("private_data_risk");
  });

  it("does not flag three-octet version string 10.20.30 as private_data_risk", () => {
    const proc = addProcedure({
      taskPattern: "Run release workflow with dependency version check",
      recipeJson: JSON.stringify([
        {
          tool: "exec",
          args: { command: "echo dependency version 10.20.30" },
          summary: "Log dependency version string",
        },
        {
          tool: "exec",
          args: { command: "npm test" },
          summary: "Run test suite",
        },
        {
          tool: "read",
          args: { path: "report.json" },
          summary: "Verify report",
        },
      ]),
      sourceSessionId: "version-string-a",
    });
    db.recordProcedureSuccess(proc.id, undefined, "version-string-b");
    db.recordProcedureSuccess(proc.id, undefined, "version-string-c");

    const evaluation = evaluateProcedureForPromotion(
      createProcedurePromotionItem(proc, parseProcedurePromotionPolicy("auto-safe")),
      parseProcedurePromotionPolicy("auto-safe"),
      { skillsAutoPath: skillsDir, validationThreshold: 3 },
    );

    expect(evaluation.metadata.rejectionReasons).not.toContain("private_data_risk");
  });
});
