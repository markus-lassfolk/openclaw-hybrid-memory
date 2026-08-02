import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGoalStewardshipConfig } from "../config/parsers/core.js";
import {
  evaluateGoalDispatch,
  type GoalDispatchPolicy,
  type GoalDispatchRequest,
} from "../services/goal-dispatch-authorization.js";

const policy: GoalDispatchPolicy = {
  version: 1,
  classes: {
    implement: {
      allowedAgents: ["implementer-a", "escalator-a"],
      readOnly: false,
      canonical: {
        repository: "acme/repo",
        prNumber: 2232,
        branch: "fix/goal-dispatch-authorization",
        remoteHead: "abc123",
      },
      writeScope: ["extensions/memory-hybrid"],
      forbidNewPr: true,
      forbidNewBranch: true,
    },
    review: { allowedAgents: ["reviewer-a"], readOnly: true },
    escalate: {
      allowedAgents: ["escalator-a"],
      readOnly: false,
      canonical: {
        repository: "acme/repo",
        prNumber: 2232,
        branch: "fix/goal-dispatch-authorization",
        remoteHead: "abc123",
      },
      writeScope: ["docs"],
      forbidNewPr: true,
      forbidNewBranch: true,
    },
  },
};
const write = (changes: Partial<GoalDispatchRequest> = {}): GoalDispatchRequest => ({
  taskClass: "implement",
  requestedAgent: "implementer-a",
  actualAgent: "implementer-a",
  readOnly: false,
  repository: "acme/repo",
  prNumber: 2232,
  branch: "fix/goal-dispatch-authorization",
  liveRemoteHead: "abc123",
  writeScope: ["extensions/memory-hybrid"],
  createsPr: false,
  createsBranch: false,
  ...changes,
});

describe("goal dispatch authorization", () => {
  it("declares dispatchAuthorization in the plugin configuration schema", () => {
    const hybridRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = JSON.parse(readFileSync(join(hybridRoot, "openclaw.plugin.json"), "utf8")) as {
      configSchema?: { properties?: { goalStewardship?: { properties?: Record<string, unknown> } } };
    };
    expect(manifest.configSchema?.properties?.goalStewardship?.properties?.dispatchAuthorization).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: expect.objectContaining({ type: "boolean" }),
        mode: expect.objectContaining({ type: "string", enum: ["audit", "enforce"] }),
      },
      description: expect.any(String),
    });
  });
  it("defaults omitted or disabled configuration to a disabled authorization gate", () => {
    expect(parseGoalStewardshipConfig({}).dispatchAuthorization).toEqual({ enabled: false });
    expect(
      parseGoalStewardshipConfig({ goalStewardship: { dispatchAuthorization: { enabled: false } } })
        .dispatchAuthorization,
    ).toEqual({ enabled: false });
  });
  it("requires explicit opt-in and a valid active mode", () => {
    expect(
      parseGoalStewardshipConfig({ goalStewardship: { dispatchAuthorization: { enabled: true } } })
        .dispatchAuthorization,
    ).toEqual({ enabled: false });
    expect(
      parseGoalStewardshipConfig({
        goalStewardship: { dispatchAuthorization: { enabled: true, mode: "audit" } },
      }).dispatchAuthorization,
    ).toEqual({ enabled: true, mode: "audit" });
  });
  it("supports custom mappings and multiple independently named classes", () => {
    expect(evaluateGoalDispatch(policy, write()).allowed).toBe(true);
    expect(
      evaluateGoalDispatch(
        policy,
        write({
          taskClass: "escalate",
          requestedAgent: "escalator-a",
          actualAgent: "escalator-a",
          writeScope: ["docs"],
        }),
      ).allowed,
    ).toBe(true);
  });
  it("rejects an identity mismatch even when both ids are allowed", () =>
    expect(evaluateGoalDispatch(policy, write({ requestedAgent: "escalator-a" })).reason).toContain("exactly match"));
  it("rejects an agent outside the selected class", () =>
    expect(
      evaluateGoalDispatch(policy, write({ actualAgent: "reviewer-a", requestedAgent: "reviewer-a" })).reason,
    ).toContain("not allowed"));
  it("accepts only explicitly declared read-only work", () =>
    expect(
      evaluateGoalDispatch(policy, {
        taskClass: "review",
        requestedAgent: "reviewer-a",
        actualAgent: "reviewer-a",
        readOnly: true,
      }).allowed,
    ).toBe(true));
  it("rejects read-only declaration mismatches and missing declarations", () => {
    expect(evaluateGoalDispatch(policy, write({ readOnly: true })).reason).toContain("readOnly");
    expect(
      evaluateGoalDispatch(policy, { taskClass: "review", requestedAgent: "reviewer-a", actualAgent: "reviewer-a" })
        .reason,
    ).toContain("readOnly");
  });
  it("rejects a missing policy for a write request", () =>
    expect(evaluateGoalDispatch(undefined, write()).allowed).toBe(false));
  it("keeps audit filenames inside the audit directory for arbitrary goal ids", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { recordGoalDispatchPreflight } = await import("../services/goal-dispatch-authorization.js");
    const goalsDir = await mkdtemp(join(tmpdir(), "goal-dispatch-audit-"));
    try {
      await recordGoalDispatchPreflight(goalsDir, "../outside", evaluateGoalDispatch(policy, write()));
      await expect(readFile(join(goalsDir, "dispatch-audit", "..%2Foutside.jsonl"), "utf8")).resolves.toContain(
        "allowed",
      );
    } finally {
      await rm(goalsDir, { recursive: true, force: true });
    }
  });
  it("rejects sibling PR/branch and stale SHA", () => {
    expect(evaluateGoalDispatch(policy, write({ prNumber: 2233, branch: "fix/sibling" })).reason).toContain(
      "non-canonical",
    );
    expect(evaluateGoalDispatch(policy, write({ liveRemoteHead: "old" })).reason).toContain("stale");
  });
  it("requires explicit non-empty write scope and creation declarations", () => {
    expect(evaluateGoalDispatch(policy, write({ writeScope: [] })).reason).toContain("write scope");
    expect(evaluateGoalDispatch(policy, write({ createsPr: undefined })).reason).toContain("creation declarations");
  });
});
