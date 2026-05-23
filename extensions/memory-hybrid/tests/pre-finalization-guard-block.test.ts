/**
 * Pre-finalization guard — block scenarios.
 */
import { describe, expect, it } from "vitest";
import { CHECKPOINT_GUARD_BYPASS_PREFIX, evaluatePreFinalizationGuard } from "../services/pre-finalization-guard.js";
import type { MemoryEntry } from "../types/memory.js";
import { NOW_ISO, NOW_MS, projectFact } from "./helpers/pre-finalization-guard-fixtures.js";

describe("pre-finalization guard", () => {
  it("blocks CI-wait finalization when checkpoint is missing", () => {
    const messages: unknown[] = [
      { role: "user", content: "Push and watch CI." },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "exec",
              arguments: JSON.stringify({ cmd: "git push origin fix/1271-pre-finalization-guard" }),
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "Branch pushed. CI checks are still pending, I will recheck later.",
      },
    ];

    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("block");
    expect(result.signals.waitingOrPending).toBe(true);
    expect(result.signals.unresolvedExternalMention).toBe(true);
    expect(result.signals.gitOrGithubMutation).toBe(true);
    expect(result.checkpoint.projectFactsSatisfied).toBe(false);
  });

  it("blocks when a background process is still running without checkpoint", () => {
    const messages: unknown[] = [
      { role: "user", content: "Start tests and report back." },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "exec", input: { cmd: "npm run test > /tmp/test.log 2>&1 &" } }],
      },
      {
        role: "assistant",
        content: "I started the test job in the background and it is still running.",
      },
    ];

    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("block");
    expect(result.signals.backgroundProcessRunning).toBe(true);
    expect(result.checkpoint.projectFactsSatisfied).toBe(false);
  });

  it("allows CI-wait when project-fact checkpoint requirements are satisfied", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "issue-1271-ci", key: "status", value: "waiting" }),
      projectFact({ id: "2", entity: "issue-1271-ci", key: "next", value: "Recheck CI in 10 minutes." }),
      projectFact({ id: "3", entity: "issue-1271-ci", key: "task_updated", value: NOW_ISO }),
      projectFact({ id: "4", entity: "issue-1271-ci", key: "related_session", value: "agent:main:main" }),
      projectFact({ id: "5", entity: "issue-1271-ci", key: "wake_at", value: "2026-05-10T08:41:00.000Z" }),
      projectFact({ id: "6", entity: "issue-1271-ci", key: "related_goal", value: "goal-1271" }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "goal_assess",
              arguments: JSON.stringify({
                goal_id: "goal-1271",
                assessment: "CI still pending.",
                next_action: "Recheck after wake window.",
              }),
            },
          },
        ],
      },
      { role: "assistant", content: "CI is pending; recheck is scheduled." },
    ];

    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "agent:main:main",
    });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("checkpoint_present");
    expect(result.checkpoint.projectFactsSatisfied).toBe(true);
    expect(result.checkpoint.projectCheckpointEntity).toBe("issue-1271-ci");
  });

  it("requires goal_assess to match the related goal id on active project rows", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "issue-1271-ci", key: "status", value: "waiting" }),
      projectFact({ id: "2", entity: "issue-1271-ci", key: "next", value: "Recheck CI in 10 minutes." }),
      projectFact({ id: "3", entity: "issue-1271-ci", key: "task_updated", value: NOW_ISO }),
      projectFact({ id: "4", entity: "issue-1271-ci", key: "related_session", value: "agent:main:main" }),
      projectFact({ id: "5", entity: "issue-1271-ci", key: "wake_at", value: "2026-05-10T08:41:00.000Z" }),
      projectFact({ id: "6", entity: "issue-1271-ci", key: "related_goal", value: "goal-1271-a" }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "goal_assess",
              arguments: JSON.stringify({
                goal_id: "goal-1271-b",
                assessment: "Different goal was assessed.",
              }),
            },
          },
        ],
      },
      { role: "assistant", content: "CI is pending; recheck is scheduled." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "agent:main:main",
    });
    expect(result.action).toBe("block");
    expect(result.checkpoint.missingFields).toContain("goal_assess");
  });

  it("allows explicit bypass with a short reason", () => {
    const messages: unknown[] = [
      { role: "user", content: "Quick status only." },
      {
        role: "assistant",
        content: `CI is still pending. ${CHECKPOINT_GUARD_BYPASS_PREFIX} user requested quick one-off.`,
      },
    ];

    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("explicit_bypass");
    expect(result.bypassReason).toContain("quick one-off");
  });

  it("warns on git/github mutation-only turns without unfinished-wait signals", () => {
    const messages: unknown[] = [
      { role: "user", content: "Commit the changes." },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "exec",
              arguments: JSON.stringify({ cmd: "git commit -m 'fix: issue 1271'" }),
            },
          },
        ],
      },
      { role: "assistant", content: "Changes committed." },
    ];

    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("warn");
    expect(result.reason).toBe("missing_checkpoint_warn");
    expect(result.signals.gitOrGithubMutation).toBe(true);
    expect(result.signals.waitingOrPending).toBe(false);
  });

  it("detects unfinished-work signals from earlier assistant messages in the same turn", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status update?" },
      { role: "assistant", content: "CI is still pending and checks are running." },
      { role: "assistant", content: "Noted." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("block");
    expect(result.signals.waitingOrPending).toBe(true);
    expect(result.signals.unresolvedExternalMention).toBe(true);
  });

  it("does not treat negated pending/waiting phrases as unfinished workflow signals", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "CI is no longer pending and nothing is waiting." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("no_external_signal");
    expect(result.signals.waitingOrPending).toBe(false);
  });

  it("does not treat negated/cleared running phrases as unresolved external signals", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "CI is no longer running; checks finished running successfully." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("allow");
    expect(result.signals.unresolvedExternalMention).toBe(false);
  });

  it("does not treat past-tense recheck language as pending work", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "I rechecked CI and it passed; no follow-up needed." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.signals.waitingOrPending).toBe(false);
    expect(result.action).toBe("allow");
  });

  it("does not infer command mutations from non-command tool payload text", () => {
    const messages: unknown[] = [
      { role: "user", content: "Assess progress." },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "goal_assess",
              arguments: JSON.stringify({
                goal_id: "goal-1",
                assessment: "Need to run git push after CI passes",
              }),
            },
          },
        ],
      },
      { role: "assistant", content: "Assessment captured." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.signals.gitOrGithubMutation).toBe(false);
  });

  it("requires waiting wake link to be persisted in facts (cron wording alone is not enough)", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "issue-1271-ci", key: "status", value: "waiting" }),
      projectFact({ id: "2", entity: "issue-1271-ci", key: "next", value: "Recheck CI in 10 minutes." }),
      projectFact({ id: "3", entity: "issue-1271-ci", key: "task_updated", value: NOW_ISO }),
      projectFact({ id: "4", entity: "issue-1271-ci", key: "related_session", value: "agent:main:main" }),
      projectFact({ id: "5", entity: "issue-1271-ci", key: "related_goal", value: "goal-1271" }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "goal_assess",
              arguments: JSON.stringify({ goal_id: "goal-1271", assessment: "Pending CI" }),
            },
          },
        ],
      },
      { role: "assistant", content: "CI is pending and recheck is scheduled." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "agent:main:main",
    });
    expect(result.action).toBe("block");
    expect(result.checkpoint.missingFields).toContain("wake_link");
  });
});
