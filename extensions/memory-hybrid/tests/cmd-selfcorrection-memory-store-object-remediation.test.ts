/**
 * Regression test (loop iteration 77) for cli/cmd-selfcorrection.ts:
 *
 * A MEMORY_STORE remediation whose `remediationContent` is an object missing the
 * `text` field fell through to `{ text: String(c), ... }`, and `String()` on a
 * plain object produces the literal string "[object Object]" — which is truthy,
 * so it was NOT caught by the `if (!rawText) continue;` guard and got stored as
 * a real fact instead of being skipped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { runSelfCorrectionRunForCli } from "../cli/cmd-selfcorrection.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";

const SAMPLE_INCIDENT: CorrectionIncident = {
  userMessage: "That was wrong — verify first.",
  precedingAssistant: "I ran the command without checking.",
  followingAssistant: "I will verify next time.",
  sessionFile: "2026-01-01-session.jsonl",
  timestamp: "2026-01-01",
};

function makeOpenAIMock(responseText: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      },
    },
  } as any;
}

let tmpDir: string;
let factsDb: FactsDB;
let proposalsDb: ProposalsDB;

function makeCtx(openai: any): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      modelName: "test-model",
    } as any,
    openai,
    proposalsDb,
    cfg: {
      procedures: { sessionsDir: tmpDir },
      distill: {},
      selfCorrection: {
        semanticDedup: false,
        semanticDedupThreshold: 0.92,
        toolsSection: "Self-correction rules",
        applyToolsByDefault: false,
        autoRewriteTools: false,
        analyzeViaSpawn: false,
        spawnThreshold: 15,
        spawnModel: "",
      },
      llm: { default: ["test-model"], heavy: ["test-model"], _source: undefined },
      store: { classifyBeforeWrite: false },
      autoRecall: { enabled: false },
      personaProposals: {
        enabled: true,
        allowedFiles: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md"],
        proposalTTLDays: 30,
        minConfidence: 0.5,
        maxProposalsPerWeek: 5,
        autoApply: false,
      },
    } as any,
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    identityReflectionStore: null,
    personaStateStore: null,
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    resolvedLancePath: join(tmpDir, "lance"),
    pluginId: "test",
    logger: { info: vi.fn(), warn: vi.fn() },
    detectCategory: () => "technical",
  } as unknown as HandlerContext;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sc-obj-remediation-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
});

afterEach(() => {
  vi.restoreAllMocks();
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MEMORY_STORE with object remediationContent missing text (loop iteration 77 regression)", () => {
  it('skips storage instead of stringifying the object to "[object Object]"', async () => {
    const remediation = {
      category: "workflow",
      severity: "medium",
      remediationType: "MEMORY_STORE",
      // No `text` key at all — the exact shape that triggered String(c) === "[object Object]".
      remediationContent: { entity: "Fact", tags: ["workflow"] },
    };
    const ctx = makeCtx(makeOpenAIMock(JSON.stringify({ items: [remediation] })));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: false,
    });

    expect(res.autoFixed).toBe(0);
    expect(factsDb.getCount()).toBe(0);
    const stored = factsDb.getBatch(0, 10);
    expect(stored.every((f) => f.text !== "[object Object]")).toBe(true);
  });

  it("still stores normally when remediationContent has a real text field", async () => {
    const remediation = {
      category: "workflow",
      severity: "medium",
      remediationType: "MEMORY_STORE",
      remediationContent: { text: "Always verify before running commands.", entity: "Fact", tags: ["workflow"] },
    };
    const ctx = makeCtx(makeOpenAIMock(JSON.stringify({ items: [remediation] })));

    const res = await runSelfCorrectionRunForCli(ctx, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: false,
    });

    expect(res.autoFixed).toBe(1);
    expect(factsDb.getCount()).toBe(1);
    const stored = factsDb.getBatch(0, 10);
    expect(stored.some((f) => f.text.includes("Always verify before running commands."))).toBe(true);
  });
});
