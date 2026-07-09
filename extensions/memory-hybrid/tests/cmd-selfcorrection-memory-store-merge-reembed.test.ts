/**
 * Regression test (loop iteration 112) for cli/cmd-selfcorrection.ts:
 *
 * The MEMORY_STORE remediation path embedded its candidate `text` before calling
 * `factsDb.storeWithResult`, then stored that pre-merge text/vector to the vector backend
 * regardless of outcome. When `storeWithResult` merges the new text onto an existing fact
 * (`newlyStored: false`, `embeddingStale: true`), `entry.text` becomes the full merged content
 * — but the skip check only bailed on the pure-dedupe case, letting the merge case fall through
 * to `vectorDb.store()` with the stale pre-merge fragment and its already-computed vector. This
 * desynced the vector backend from the fact row's real persisted text, the identical bug class
 * already fixed in the sibling cli/cmd-distill.ts and cli/cmd-extract-reinforcement.ts (commit
 * 9074af9) but missed in this third file.
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

function makeCtx(openai: any, embedCalls: string[]): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as any,
    embeddings: {
      embed: vi.fn(async (text: string) => {
        embedCalls.push(text);
        return [0.1, 0.2, 0.3];
      }),
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
  tmpDir = mkdtempSync(join(tmpdir(), "sc-merge-reembed-"));
  // fuzzyDedupe + onDuplicate: merge for the "self-correction" source, matching the convention
  // in tests/cmd-extract-reinforcement-batch.test.ts, so a plain case-insensitive hash duplicate
  // deterministically merges without needing a real embedding-similarity feed.
  factsDb = new FactsDB(join(tmpDir, "facts.db"), {
    fuzzyDedupe: true,
    storeConfig: { fuzzyDedupe: true, sourceProfiles: { "self-correction": { onDuplicate: "merge" } } },
  });
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
});

afterEach(() => {
  vi.restoreAllMocks();
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MEMORY_STORE merge re-embeds the merged text (loop iteration 112 regression)", () => {
  it("stores entry.text (the merged content), not the pre-merge fragment, when storeWithResult merges", async () => {
    const firstText = "Deployed the payment service to production version one.";
    const secondText = "DEPLOYED THE PAYMENT SERVICE TO PRODUCTION VERSION ONE.";
    const embedCalls: string[] = [];

    const firstRemediation = {
      category: "workflow",
      severity: "medium",
      remediationType: "MEMORY_STORE",
      remediationContent: { text: firstText, entity: "Fact", tags: ["workflow"] },
    };
    const ctx1 = makeCtx(makeOpenAIMock(JSON.stringify({ items: [firstRemediation] })), embedCalls);
    const res1 = await runSelfCorrectionRunForCli(ctx1, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: false,
    });
    expect(res1.autoFixed).toBe(1);

    const secondRemediation = {
      category: "workflow",
      severity: "medium",
      remediationType: "MEMORY_STORE",
      remediationContent: { text: secondText, entity: "Fact", tags: ["workflow"] },
    };
    const vectorDbStore = vi.fn().mockResolvedValue(undefined);
    const ctx2 = makeCtx(makeOpenAIMock(JSON.stringify({ items: [secondRemediation] })), embedCalls);
    ctx2.vectorDb = {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vectorDbStore,
    } as unknown as HandlerContext["vectorDb"];
    // Bypass the cheap pre-check so the real storeWithResult merge path runs.
    vi.spyOn(factsDb, "hasDuplicate").mockReturnValue(false);

    const res2 = await runSelfCorrectionRunForCli(ctx2, {
      incidents: [SAMPLE_INCIDENT],
      workspace: tmpDir,
      dryRun: false,
    });
    expect(res2.autoFixed).toBe(1);

    // list()'s category filter validates against a stricter enum than storeWithResult's own
    // write-time validation, so filtering by category:"technical" here would silently return []
    // even though the fact really was stored with that category -- list unfiltered instead.
    const stored = factsDb.list(20, {}).find((f) => f.source === "self-correction");
    expect(stored?.text).toContain(firstText);
    expect(stored?.text).toContain(secondText);
    expect(stored?.text).not.toBe(secondText);

    const storedTexts = vectorDbStore.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(storedTexts).toContain(stored?.text);
    expect(storedTexts.every((t) => t !== secondText)).toBe(true);
    expect(embedCalls.some((t) => t === stored?.text)).toBe(true);
  });
});
