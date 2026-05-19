import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_GUARD_BYPASS_PREFIX,
  evaluatePreFinalizationGuard,
  formatPreFinalizationGuardMessage,
  type PreFinalizationGuardResult,
} from "../services/pre-finalization-guard.js";
import type { MemoryEntry } from "../types/memory.js";

const NOW_ISO = "2026-05-10T08:31:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function projectFact(params: {
  id: string;
  entity: string;
  key: string;
  value: string;
  createdAt?: number;
}): MemoryEntry {
  return {
    id: params.id,
    text: `Task [${params.entity}] ${params.key}: ${params.value}`,
    category: "project",
    importance: 0.7,
    entity: params.entity,
    key: params.key,
    value: params.value,
    source: "test",
    createdAt: params.createdAt ?? Math.floor(NOW_MS / 1000),
    decayClass: "permanent",
    expiresAt: null,
    lastConfirmedAt: Math.floor(NOW_MS / 1000),
    confidence: 1,
  };
}

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

  it("ignores project entities owned by other sessions (no checkpoint obligation for this session)", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "issue-1271-ci", key: "status", value: "in_progress" }),
      projectFact({ id: "2", entity: "issue-1271-ci", key: "next", value: "Continue processing." }),
      projectFact({ id: "3", entity: "issue-1271-ci", key: "task_updated", value: NOW_ISO }),
      projectFact({ id: "4", entity: "issue-1271-ci", key: "related_session", value: "agent:main:other-session" }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "agent:main:current-session",
    });
    // The entity belongs to another session; this session has no checkpoint obligation.
    expect(result.action).toBe("allow");
    expect(result.checkpoint.missingFields).toHaveLength(0);
    expect(result.checkpoint.missingFields).not.toContain("related_session");
  });

  it("formats conditional wake/goal requirements in the guard message", () => {
    const result: PreFinalizationGuardResult = {
      action: "block",
      reason: "missing_checkpoint_block",
      signals: {
        waitingOrPending: true,
        cronWakeScheduled: false,
        backgroundProcessRunning: false,
        gitOrGithubMutation: false,
        unresolvedExternalMention: true,
      },
      checkpoint: {
        activeTaskCheckpointCalled: false,
        goalAssessCalled: false,
        projectFactsSatisfied: false,
        missingFields: ["wake_link", "goal_assess"],
      },
      bypassReason: null,
    };
    const message = formatPreFinalizationGuardMessage(result);
    expect(message).toContain("wake");
    expect(message).toContain("goal_assess");
  });

  it("allows hypothetical active_task_checkpoint tool as direct satisfaction path", () => {
    const messages: unknown[] = [
      { role: "user", content: "Pause and continue later." },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "active_task_checkpoint",
              arguments: JSON.stringify({ label: "issue-1271", status: "waiting", next: "Recheck CI" }),
            },
          },
        ],
      },
      { role: "assistant", content: "Still waiting for CI, I will continue later." },
    ];

    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("checkpoint_present");
    expect(result.checkpoint.activeTaskCheckpointCalled).toBe(true);
  });

  it("detects OpenClaw toolCall content blocks as tool evidence", () => {
    const messages: unknown[] = [
      { role: "user", content: "Pause and continue later." },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "active_task_checkpoint",
            arguments: { entity: "issue-1271", status: "waiting", next: "Recheck CI" },
          },
        ],
      },
      { role: "assistant", content: "Still waiting for CI, I will continue later." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("checkpoint_present");
    expect(result.checkpoint.activeTaskCheckpointCalled).toBe(true);
  });

  // ── multi-agent related_session shapes (#1479) ──────────────────────────────

  it("allows when all active ledger rows belong to forge/pr-steward subagents (global noise)", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "fix-pr-1457-typecheck", key: "status", value: "blocked" }),
      projectFact({ id: "2", entity: "fix-pr-1457-typecheck", key: "next", value: "Waiting for review." }),
      projectFact({ id: "3", entity: "fix-pr-1457-typecheck", key: "task_updated", value: NOW_ISO }),
      projectFact({
        id: "4",
        entity: "fix-pr-1457-typecheck",
        key: "related_session",
        value: "agent:forge:subagent:fec9e6ed-0000-0000-0000-000000000001",
      }),
      projectFact({ id: "5", entity: "pr-stewardship-pr-1454", key: "status", value: "blocked" }),
      projectFact({ id: "6", entity: "pr-stewardship-pr-1454", key: "next", value: "Merge pending." }),
      projectFact({ id: "7", entity: "pr-stewardship-pr-1454", key: "task_updated", value: NOW_ISO }),
      projectFact({
        id: "8",
        entity: "pr-stewardship-pr-1454",
        key: "related_session",
        value: "agent:pr-steward:subagent:69b0d87d-0000-0000-0000-000000000002",
      }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI to finish the queue run." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
    });
    expect(result.action).toBe("allow");
  });

  it("allows when active entity has related_session='pending' (unresolved placeholder)", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "hybrid-memory-pr-merge-gate", key: "status", value: "in_progress" }),
      projectFact({ id: "2", entity: "hybrid-memory-pr-merge-gate", key: "next", value: "Waiting for gate." }),
      projectFact({ id: "3", entity: "hybrid-memory-pr-merge-gate", key: "task_updated", value: NOW_ISO }),
      projectFact({ id: "4", entity: "hybrid-memory-pr-merge-gate", key: "related_session", value: "pending" }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
    });
    expect(result.action).toBe("allow");
  });

  it("allows when active entity has related_session set to a GitHub PR URL", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "hybrid-memory-pr1332", key: "status", value: "in_progress" }),
      projectFact({ id: "2", entity: "hybrid-memory-pr1332", key: "next", value: "Final review." }),
      projectFact({ id: "3", entity: "hybrid-memory-pr1332", key: "task_updated", value: NOW_ISO }),
      projectFact({
        id: "4",
        entity: "hybrid-memory-pr1332",
        key: "related_session",
        value: "https://github.com/org/repo/pull/1332",
      }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
    });
    expect(result.action).toBe("allow");
  });

  it("allows when active entity has no related_session fact at all", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "smoke-test", key: "status", value: "in_progress" }),
      projectFact({ id: "2", entity: "smoke-test", key: "next", value: "Continue smoke test." }),
      projectFact({ id: "3", entity: "smoke-test", key: "task_updated", value: NOW_ISO }),
      // no related_session fact
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
    });
    expect(result.action).toBe("allow");
  });

  it("still blocks when a session-owned entity lacks checkpoint fields", () => {
    const facts: MemoryEntry[] = [
      projectFact({ id: "1", entity: "own-task", key: "status", value: "in_progress" }),
      // missing: next, task_updated
      projectFact({
        id: "2",
        entity: "own-task",
        key: "related_session",
        value: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
      }),
    ];
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "Still waiting for CI." },
    ];
    const result = evaluatePreFinalizationGuard(messages, {
      nowMs: NOW_MS,
      projectFacts: facts,
      sessionKey: "bc88cdda-db96-4c80-9021-44015f2ca1d9",
    });
    expect(result.action).toBe("block");
    expect(result.checkpoint.missingFields).toContain("next");
    expect(result.checkpoint.missingFields).toContain("task_updated");
    expect(result.checkpoint.missingFields).not.toContain("related_session");
  });

  // ── Fix C: tightened WAITING_OR_PENDING_RE (#1479) ──────────────────────────

  it("does not treat batch-queue 'pending' language as unfinished workflow signal", () => {
    const messages: unknown[] = [
      { role: "user", content: "How many issues are left?" },
      { role: "assistant", content: "The script processes 10 pending source issues per run." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.signals.waitingOrPending).toBe(false);
    expect(result.action).toBe("allow");
  });

  it("still detects 'still pending' as an unfinished workflow signal", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "The CI run is still pending." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.signals.waitingOrPending).toBe(true);
  });

  it("still detects 'pending review' as an unfinished workflow signal", () => {
    const messages: unknown[] = [
      { role: "user", content: "Status?" },
      { role: "assistant", content: "The PR is pending review before merge." },
    ];
    const result = evaluatePreFinalizationGuard(messages, { nowMs: NOW_MS, projectFacts: [] });
    expect(result.signals.waitingOrPending).toBe(true);
  });
});
