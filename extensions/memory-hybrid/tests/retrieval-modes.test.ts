import { describe, expect, it, vi } from "vitest";
import {
  buildExplicitSemanticQueryVector,
  DEFAULT_RETRIEVAL_CONFIG,
} from "../services/retrieval-orchestrator.js";
import {
  resolveExplicitDeepRetrievalPolicy,
  resolveInteractiveRecallPolicy,
} from "../services/retrieval-mode-policy.js";

function makeMockOpenAI(response: string | Error): object {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          if (response instanceof Error) throw response;
          return {
            choices: [{ message: { content: response } }],
          };
        }),
      },
    },
  };
}

describe("retrieval mode policy", () => {
  it("names the interactive recall owner and keeps HyDE off by default", () => {
    const policy = resolveInteractiveRecallPolicy({
      enabled: true,
      maxTokens: 700,
      maxPerMemoryChars: 240,
      injectionFormat: "minimal",
      limit: 8,
      minScore: 0.2,
      preferLongTerm: false,
      useImportanceRecency: true,
      entityLookup: { enabled: false, entities: [], maxFactsPerEntity: 0 },
      retrievalDirectives: {
        enabled: false,
        entityMentioned: false,
        keywords: [],
        taskTypes: {},
        sessionStart: false,
        limit: 0,
        maxPerPrompt: 0,
      },
      summaryThreshold: 0,
      summaryMaxChars: 0,
      useSummaryInInjection: false,
      summarizeWhenOverBudget: false,
      authFailure: { enabled: false, patterns: [], maxRecallsPerTarget: 0, includeVaultHints: false },
    });

    expect(policy.mode).toBe("interactive-recall");
    expect(policy.ownerModule).toBe("lifecycle/stage-recall.ts");
    expect(policy.contextBudgetTokens).toBe(700);
    expect(policy.allowHyde).toBe(false);
  });

  it("names the explicit/deep owner and uses explicit retrieval budget", () => {
    const policy = resolveExplicitDeepRetrievalPolicy({
      ...DEFAULT_RETRIEVAL_CONFIG,
      explicitBudgetTokens: 4321,
    });

    expect(policy.mode).toBe("explicit-deep");
    expect(policy.ownerModule).toBe("services/retrieval-orchestrator.ts");
    expect(policy.budgetTokens).toBe(4321);
    expect(policy.allowHyde).toBe(true);
    expect(policy.allowRrfFusion).toBe(true);
  });
});

describe("buildExplicitSemanticQueryVector", () => {
  it("uses HyDE on the explicit/deep path when query expansion is enabled", async () => {
    const embeddings = { embed: vi.fn(async (text: string) => [text.length]) };
    const result = await buildExplicitSemanticQueryVector({
      query: "where is the api key",
      cfg: {
        llm: undefined,
        retrieval: DEFAULT_RETRIEVAL_CONFIG,
        queryExpansion: { enabled: true, mode: "always", maxVariants: 4, cacheSize: 50, timeoutMs: 5000 },
      },
      embeddings,
      openai: makeMockOpenAI("The API key is stored in the secrets file.") as never,
      pendingLLMWarnings: { add: vi.fn(), drain: vi.fn(() => []) },
      logger: { warn: vi.fn() },
    });

    expect(embeddings.embed).toHaveBeenCalledWith("The API key is stored in the secrets file.");
    expect(result.warning).toBeNull();
    expect(result.queryVector).toEqual([42]);
  });

  it("falls back to the raw query when HyDE fails on the explicit/deep path", async () => {
    const embeddings = { embed: vi.fn(async (text: string) => [text.length]) };
    const logger = { warn: vi.fn() };
    const result = await buildExplicitSemanticQueryVector({
      query: "find the backup host",
      cfg: {
        llm: undefined,
        retrieval: DEFAULT_RETRIEVAL_CONFIG,
        queryExpansion: { enabled: true, mode: "always", maxVariants: 4, cacheSize: 50, timeoutMs: 5000 },
      },
      embeddings,
      openai: makeMockOpenAI(new Error("boom")) as never,
      pendingLLMWarnings: { add: vi.fn(), drain: vi.fn(() => []) },
      logger,
    });

    expect(embeddings.embed).toHaveBeenCalledWith("find the backup host");
    expect(logger.warn).toHaveBeenCalled();
    expect(result.warning).toBeNull();
    expect(result.queryVector).toEqual([20]);
  });
});
