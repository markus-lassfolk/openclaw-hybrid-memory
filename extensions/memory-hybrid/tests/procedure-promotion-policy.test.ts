import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { ProcedureEntry } from "../types/memory.js";
import {
  PROCEDURE_PROMOTION_POLICY_VERSION,
  ProcedurePromotionAdapter,
  createProcedurePromotionDecision,
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  parseProcedurePromotionPolicy,
} from "../services/procedure-promotion-policy.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
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
      existsSync(join(skillsDir, "validate-release-health-report-with-objective-checks", "evals", "evals.json")),
    ).toBe(true);

    const skill = readFileSync(skillPath, "utf-8");
    for (const section of [
      "## Trigger",
      "## Scope",
      "## When not to use",
      "## Workflow",
      "## Safe tool usage",
      "## Validation",
      "## Failure handling",
      "## Rollback / disable guidance",
      "## Examples",
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
    });
    expect(verification.sourceProcedureIds).toEqual([proc.id]);
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

  it("standalone and parent adapter route produce equivalent decisions", async () => {
    const proc = addProcedure({ sourceSessionId: "eq-a" });
    db.recordProcedureSuccess(proc.id, undefined, "eq-b");
    db.recordProcedureSuccess(proc.id, undefined, "eq-c");
    const policy = parseProcedurePromotionPolicy("auto-safe");
    const item = createProcedurePromotionItem(requireProcedure(proc.id), policy);
    const adapter = new ProcedurePromotionAdapter([requireProcedure(proc.id)], policy, {
      skillsAutoPath: skillsDir,
      validationThreshold: 3,
    });
    const [listed] = adapter.listPending();

    await expectStandaloneAndParentDecisionsEquivalent({
      fixtures: [{ item, policy, policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION }],
      standalone: (fixture, context) => adapter.decide(fixture, context),
      parent: (_fixture, context) => adapter.decide(listed, context),
    });
  });
});
