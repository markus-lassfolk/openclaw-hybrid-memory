/**
 * End-to-end test for `hybrid-mem distill` — the maintenance pipeline that scans real session
 * transcripts for memory-worthy content and stores it. Every existing distill test
 * (cmd-distill.test.ts, distill-vector-dedupe.test.ts, distill-days-flag-validation.test.ts, etc.)
 * only unit-tests a helper function in isolation; none of them call `runDistillForCli` itself
 * against a real session file + real FactsDB/VectorDB. This file exercises the full scan -> LLM
 * extract -> dedupe -> store pipeline end to end with real backends and asserts the actual stored
 * fact + vector, not just a returned count.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDistillForCli } from "../cli/cmd-distill.js";
import type { HandlerContext } from "../cli/handlers.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB, VectorDB } = _testing;

const DIM = 8;

function makeEmbeddings() {
  let counter = 0;
  return {
    embed: vi.fn(async () => {
      counter++;
      const vec = new Array(DIM).fill(0.05);
      vec[counter % DIM] = 0.9;
      return vec;
    }),
    modelName: "test-embedding-model",
  };
}

/** One distill batch response: a single well-formed candidate fact as line-delimited JSON. */
function makeDistillOpenAI(factLine: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: factLine } }],
        }),
      },
    },
  };
}

const BILLING_FACT_LINE = JSON.stringify({
  category: "decision",
  text: "Team decided to migrate the billing queue to exponential backoff retries after repeated webhook failures.",
  entity: "BillingTeam",
  key: "retryStrategy",
  value: "exponential backoff",
});

function getMinimalConfig(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    ...overrides,
  });
}

describe("distill happy-path e2e (real session file -> real FactsDB + VectorDB)", () => {
  let homeDir: string;
  let dbDir: string;
  let originalHome: string | undefined;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;

  const sink = { log: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "distill-e2e-home-"));
    dbDir = mkdtempSync(join(tmpdir(), "distill-e2e-db-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    factsDb = new FactsDB(join(dbDir, "facts.db"));
    vectorDb = new VectorDB(join(dbDir, "lance"), DIM);
    sink.log.mockClear();
    sink.warn.mockClear();
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else Reflect.deleteProperty(process.env, "HOME");
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeSessionFile(agentName: string, sessionFile: string, lines: string[]): string {
    const sessionsDir = join(homeDir, ".openclaw", "agents", agentName, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, sessionFile);
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    return filePath;
  }

  function buildCtx(openai: ReturnType<typeof makeDistillOpenAI>): HandlerContext {
    return {
      factsDb,
      vectorDb,
      embeddings: makeEmbeddings(),
      openai: openai as unknown as HandlerContext["openai"],
      cfg: getMinimalConfig(),
      credentialsDb: null,
      aliasDb: null,
      wal: null,
      proposalsDb: null,
      identityReflectionStore: null,
      personaStateStore: null,
      resolvedSqlitePath: join(dbDir, "facts.db"),
      resolvedLancePath: join(dbDir, "lance"),
      pluginId: "memory-hybrid",
      logger: { info: () => undefined, warn: () => undefined },
      detectCategory: () => "other",
    } as unknown as HandlerContext;
  }

  it("scans a real session transcript, extracts a candidate fact via the LLM, and stores it with a vector", async () => {
    writeSessionFile("main-agent", "session-1.jsonl", [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "We keep seeing webhook delivery failures on the billing queue during traffic spikes.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Let's migrate the billing queue to exponential backoff retries to absorb the spikes.",
            },
          ],
        },
      }),
    ]);

    const ctx = buildCtx(makeDistillOpenAI(BILLING_FACT_LINE));
    const result = await runDistillForCli(ctx, { dryRun: false, all: true, model: "gpt-4o-mini" }, sink);

    expect(result.sessionsScanned).toBe(1);
    expect(result.factsExtracted).toBe(1);
    expect(result.stored).toBe(1);
    expect(result.dedupSkipped).toBe(0);

    const facts = factsDb.getAll();
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe("decision");
    expect(facts[0].entity).toBe("BillingTeam");
    expect(facts[0].source).toBe("distillation");

    const vectorIds = await vectorDb.getAllIds();
    expect(vectorIds).toContain(facts[0].id);
  });

  it("does not store the same memory twice when the same session content is distilled again (QA follow-up)", async () => {
    writeSessionFile("main-agent", "session-1.jsonl", [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "We keep seeing webhook delivery failures on the billing queue." }],
        },
      }),
    ]);

    const ctxFirst = buildCtx(makeDistillOpenAI(BILLING_FACT_LINE));
    const firstRun = await runDistillForCli(ctxFirst, { dryRun: false, all: true, model: "gpt-4o-mini" }, sink);
    expect(firstRun.stored).toBe(1);

    // A second distill pass over the same content (e.g. the next scheduled digest run before the
    // watermark advances, or a re-run with --all) must recognize the fact already exists rather
    // than creating a duplicate row.
    const ctxSecond = buildCtx(makeDistillOpenAI(BILLING_FACT_LINE));
    const secondRun = await runDistillForCli(ctxSecond, { dryRun: false, all: true, model: "gpt-4o-mini" }, sink);
    expect(secondRun.stored).toBe(0);
    expect(secondRun.dedupSkipped).toBe(1);

    expect(factsDb.getAll()).toHaveLength(1);
  });
});
