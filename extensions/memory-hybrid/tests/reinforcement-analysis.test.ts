/**
 * Tests for LLM-powered reinforcement analysis pipeline (#260):
 * - inferTargetFile returns correct identity files
 * - POSITIVE_RULE inserts into TOOLS.md under positive section
 * - PATTERN_FACT stores with correct category and tags
 * - PROPOSAL creates entry in proposals DB
 * - AGENTS_RULE from self-correction creates proposal in proposals DB
 * - Semantic dedup prevents duplicate rules
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferTargetFile, runExtractReinforcementForCli, runSelfCorrectionRunForCli } from "../cli/handlers.js";
import { FactsDB } from "../backends/facts-db.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { HandlerContext } from "../cli/handlers.js";

// ---------------------------------------------------------------------------
// inferTargetFile
// ---------------------------------------------------------------------------

describe("inferTargetFile (#260)", () => {
  it("returns IDENTITY.md for identity/name/role content", () => {
    expect(inferTargetFile("This rule is about the agent identity and name")).toBe("IDENTITY.md");
    expect(inferTargetFile("The creature persona should be consistent")).toBe("IDENTITY.md");
    expect(inferTargetFile("Agent role definition")).toBe("IDENTITY.md");
  });

  it("returns USER.md for preference/style/workflow content", () => {
    expect(inferTargetFile("User preference for dark mode")).toBe("USER.md");
    expect(inferTargetFile("Working style: async-first communication")).toBe("USER.md");
    expect(inferTargetFile("Workflow for code reviews")).toBe("USER.md");
    expect(inferTargetFile("Tooling setup: use bun not npm")).toBe("USER.md");
  });

  it("returns SOUL.md for behavioral/communication content", () => {
    expect(inferTargetFile("Be proactive and break tasks into milestones")).toBe("SOUL.md");
    expect(inferTargetFile("Always post thorough code review comments")).toBe("SOUL.md");
    expect(inferTargetFile("Some generic behavioral rule")).toBe("SOUL.md");
  });

  it("defaults to SOUL.md when no pattern matches", () => {
    expect(inferTargetFile("")).toBe("SOUL.md");
    expect(inferTargetFile("xyz abc 123")).toBe("SOUL.md");
  });
});

// ---------------------------------------------------------------------------
// Helpers for creating a minimal HandlerContext
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;
let proposalsDb: ProposalsDB;

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

function makeCtx(openai: any, extra: Partial<HandlerContext> = {}): HandlerContext {
  return {
    factsDb,
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      modelName: "test-model",
    } as any,
    openai,
    proposalsDb,
    cfg: {
      procedures: { sessionsDir: tmpDir },
      distill: {},
      reinforcement: {
        enabled: true,
        passiveBoost: 0.1,
        activeBoost: 0.05,
        maxConfidence: 1.0,
        similarityThreshold: 0.85,
        trackContext: true,
        maxEventsPerFact: 50,
      },
      selfCorrection: {
        semanticDedup: false,
        semanticDedupThreshold: 0.92,
        toolsSection: "Self-correction rules",
        applyToolsByDefault: true,
        autoRewriteTools: false,
        analyzeViaSpawn: false,
        spawnThreshold: 15,
        spawnModel: "",
        positiveRulesSection: "Positive Reinforcement Rules",
        reinforcementLLMAnalysis: true,
        reinforcementToProposals: true,
        agentsRuleToProposals: true,
      },
      llm: { default: ["test-model"], heavy: ["test-model"], _source: undefined },
      store: { classifyBeforeWrite: false },
      autoRecall: { enabled: false },
    } as any,
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    resolvedLancePath: join(tmpDir, "lance"),
    pluginId: "test",
    logger: { info: vi.fn(), warn: vi.fn() },
    detectCategory: () => "technical",
    ...extra,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reinf-analysis-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  proposalsDb = new ProposalsDB(join(tmpDir, "proposals.db"));
  // Create a dummy session file so sessions scan doesn't fail
  writeFileSync(join(tmpDir, "2026-01-01-session.jsonl"), "", "utf-8");
});

afterEach(() => {
  factsDb.close();
  proposalsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POSITIVE_RULE → TOOLS.md
// ---------------------------------------------------------------------------

describe("POSITIVE_RULE inserts into TOOLS.md (#260)", () => {
  it("inserts rule under Positive Reinforcement Rules section", async () => {
    const toolsPath = join(tmpDir, "TOOLS.md");
    writeFileSync(toolsPath, "# TOOLS\n\n", "utf-8");

    const llmResponse = JSON.stringify([
      {
        category: "workflow",
        severity: "strong",
        remediationType: "POSITIVE_RULE",
        remediationContent: "Break complex tasks into milestone-based sub-agents.",
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    // Create a session JSONL with a praised response
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I broke the task into three milestones and spawned sub-agents for each one. Here are the results.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Perfect! That's exactly the workflow I wanted. Keep doing it this way." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai);
    // Override workspace to tmpDir so TOOLS.md lookup finds our file
    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    expect(openai.chat.completions.create).toHaveBeenCalled();
    const toolsContent = readFileSync(toolsPath, "utf-8");
    expect(toolsContent).toContain("Positive Reinforcement Rules");
    expect(toolsContent).toContain("Break complex tasks into milestone-based sub-agents.");
  });
});

// ---------------------------------------------------------------------------
// PATTERN_FACT → facts DB
// ---------------------------------------------------------------------------

describe("PATTERN_FACT stores with correct category and tags (#260)", () => {
  it("stores pattern fact with reinforcement + behavioral tags", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "behavior",
        severity: "strong",
        remediationType: "PATTERN_FACT",
        remediationContent: {
          text: "User consistently praises proactive CI fixes done without being asked",
          tags: ["ci", "proactive"],
        },
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I noticed the lint was failing in CI so I fixed it proactively before you asked.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Yes! Exactly like that. Love when you catch issues proactively." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai);
    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    const allFacts = factsDb.getAll({});
    const patternFact = allFacts.find((f) => f.category === "pattern" && f.text.includes("CI fixes"));
    expect(patternFact).toBeDefined();
    expect(patternFact!.source).toBe("reinforcement-analysis");
    const rawTags = patternFact!.tags;
    const tags: string[] =
      typeof rawTags === "string"
        ? (JSON.parse(rawTags) as string[])
        : Array.isArray(rawTags)
          ? (rawTags as string[])
          : [];
    expect(tags).toContain("reinforcement");
    expect(tags).toContain("behavioral");
    expect(tags).toContain("ci");
  });
});

// ---------------------------------------------------------------------------
// MEMORY_STORE → facts DB (technical category, semantic dedup)
// ---------------------------------------------------------------------------

describe("MEMORY_STORE stores fact with semantic dedup (#260)", () => {
  it("stores fact with technical category when no duplicate exists", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "technical",
        severity: "strong",
        remediationType: "MEMORY_STORE",
        remediationContent: {
          text: "User prefers async/await over promise chains in TypeScript",
          entity: null,
          key: "ts-style",
          tags: ["typescript", "style"],
        },
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I rewrote the function using async/await for clarity." }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Perfect, always prefer async/await in this codebase." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai);
    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    const allFacts = factsDb.getAll({});
    const stored = allFacts.find((f) => f.category === "technical" && f.text.includes("async/await"));
    expect(stored).toBeDefined();
    expect(stored!.source).toBe("reinforcement-analysis");
  });

  it("skips MEMORY_STORE when vectorDb.hasDuplicate returns true", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "technical",
        severity: "strong",
        remediationType: "MEMORY_STORE",
        remediationContent: {
          text: "User prefers async/await over promise chains",
          tags: [],
        },
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Using async/await here." }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Good, keep using async/await." }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai, {
      cfg: {
        procedures: { sessionsDir: tmpDir },
        distill: {},
        reinforcement: {
          enabled: true,
          passiveBoost: 0.1,
          activeBoost: 0.05,
          maxConfidence: 1.0,
          similarityThreshold: 0.85,
          trackContext: true,
          maxEventsPerFact: 50,
        },
        selfCorrection: {
          semanticDedup: true,
          semanticDedupThreshold: 0.92,
          toolsSection: "Self-correction rules",
          applyToolsByDefault: true,
          autoRewriteTools: false,
          analyzeViaSpawn: false,
          spawnThreshold: 15,
          spawnModel: "",
          positiveRulesSection: "Positive Reinforcement Rules",
          reinforcementLLMAnalysis: true,
          reinforcementToProposals: true,
          agentsRuleToProposals: true,
        },
        llm: { default: ["test-model"], heavy: ["test-model"] },
        store: { classifyBeforeWrite: false },
        autoRecall: { enabled: false },
      } as any,
      vectorDb: {
        hasDuplicate: vi.fn().mockResolvedValue(true), // always a duplicate
        store: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // No facts should be stored — semantic dedup blocked it
    const allFacts = factsDb.getAll({});
    const stored = allFacts.find((f) => f.category === "technical" && f.source === "reinforcement-analysis");
    expect(stored).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROPOSAL → proposals DB
// ---------------------------------------------------------------------------

describe("PROPOSAL creates entry in proposals DB (#260)", () => {
  it("stores proposal with correct target file", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "workflow",
        severity: "strong",
        remediationType: "PROPOSAL",
        remediationContent: {
          targetFile: "USER.md",
          suggestedChange: "Add to Working Style: Values thorough inline code reviews with resolvable threads",
        },
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Here's a thorough PR review with inline comments as resolvable threads." },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Brilliant! This is exactly how I like code reviews done. Keep this format." },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai);
    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    const proposals = proposalsDb.list();
    const prop = proposals.find((p) => p.targetFile === "USER.md");
    expect(prop).toBeDefined();
    expect(prop!.suggestedChange).toContain("Working Style");
    expect(prop!.title).toContain("Reinforcement");
  });
});

// ---------------------------------------------------------------------------
// AGENTS_RULE → proposals DB from self-correction (#260)
// ---------------------------------------------------------------------------

describe("AGENTS_RULE from self-correction creates proposal in DB (#260)", () => {
  it("creates proposal when AGENTS_RULE remediation is returned", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "PASSIVE_WAITING",
        severity: "MEDIUM",
        remediationType: "AGENTS_RULE",
        remediationContent: "When a sub-agent completes, immediately continue with next task without waiting.",
        repeated: false,
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const reportDir = join(tmpDir, "memory", "reports");
    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "I'll wait here for further instructions." }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "No, you should continue automatically without waiting." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai);

    await runSelfCorrectionRunForCli(ctx, {
      incidents: [
        {
          userMessage: "No, you should continue automatically without waiting.",
          agentMessage: "I'll wait here for further instructions.",
          sessionFile: "2026-01-01-session.jsonl",
          timestamp: "2026-01-01T00:00:00.000Z",
        } as any,
      ],
      workspace: tmpDir,
    });

    const proposals = proposalsDb.list();
    const agentsRuleProp = proposals.find((p) => p.suggestedChange.includes("sub-agent"));
    expect(agentsRuleProp).toBeDefined();
    expect(agentsRuleProp!.title).toContain("Self-correction");
    // SOUL.md is the default for behavioral content
    expect(agentsRuleProp!.targetFile).toBe("SOUL.md");
  });
});

// ---------------------------------------------------------------------------
// Semantic dedup: skip duplicate PATTERN_FACT
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Semantic dedup: skip duplicate POSITIVE_RULE
// ---------------------------------------------------------------------------

describe("Semantic dedup prevents duplicate positive rules (#260)", () => {
  it("skips POSITIVE_RULE when vectorDb.hasDuplicate returns true", async () => {
    const toolsPath = join(tmpDir, "TOOLS.md");
    writeFileSync(toolsPath, "# TOOLS\n\n", "utf-8");

    const llmResponse = JSON.stringify([
      {
        category: "workflow",
        severity: "strong",
        remediationType: "POSITIVE_RULE",
        remediationContent: "Always proactively fix lint errors without being asked.",
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "I fixed the lint errors proactively." }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Great! Love this approach." }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai, {
      cfg: {
        procedures: { sessionsDir: tmpDir },
        distill: {},
        reinforcement: {
          enabled: true,
          passiveBoost: 0.1,
          activeBoost: 0.05,
          maxConfidence: 1.0,
          similarityThreshold: 0.85,
          trackContext: true,
          maxEventsPerFact: 50,
        },
        selfCorrection: {
          semanticDedup: true,
          semanticDedupThreshold: 0.92,
          toolsSection: "Self-correction rules",
          applyToolsByDefault: true,
          autoRewriteTools: false,
          analyzeViaSpawn: false,
          spawnThreshold: 15,
          spawnModel: "",
          positiveRulesSection: "Positive Reinforcement Rules",
          reinforcementLLMAnalysis: true,
          reinforcementToProposals: true,
          agentsRuleToProposals: true,
        },
        llm: { default: ["test-model"], heavy: ["test-model"] },
        store: { classifyBeforeWrite: false },
        autoRecall: { enabled: false },
      } as any,
      vectorDb: {
        hasDuplicate: vi.fn().mockResolvedValue(true), // always a duplicate
        store: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // Rule should NOT have been inserted because vectorDb.hasDuplicate returned true
    const toolsContent = readFileSync(toolsPath, "utf-8");
    expect(toolsContent).not.toContain("lint errors");
  });

  it("skips POSITIVE_RULE when exact text already in TOOLS.md", async () => {
    const rule = "Always proactively fix lint errors without being asked.";
    const toolsPath = join(tmpDir, "TOOLS.md");
    writeFileSync(toolsPath, `# TOOLS\n\n## Positive Reinforcement Rules\n\n- ${rule}\n`, "utf-8");

    const llmResponse = JSON.stringify([
      {
        category: "workflow",
        severity: "strong",
        remediationType: "POSITIVE_RULE",
        remediationContent: rule,
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "I fixed the lint errors proactively." }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Great! Love this approach." }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai, {
      vectorDb: {
        hasDuplicate: vi.fn().mockResolvedValue(false),
        store: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // Rule text appears only once (the original), not duplicated
    const toolsContent = readFileSync(toolsPath, "utf-8");
    const occurrences = (toolsContent.match(/lint errors/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Diversity score affects boost amount
// ---------------------------------------------------------------------------

describe("Diversity score affects boost amount (#259)", () => {
  it("reinforceFact uses higher boost for diverse reinforcement history", () => {
    // Seed the fact with diverse prior events so diversity score is 1.0
    const fact = factsDb.store({
      text: "Proactive fixes are praised",
      category: "pattern",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Add two events with distinct queries → diversity = 2/2 = 1.0
    factsDb.reinforceFact(fact.id, "praise A", { querySnippet: "query alpha" }, { boostAmount: 1 });
    factsDb.reinforceFact(fact.id, "praise B", { querySnippet: "query beta" }, { boostAmount: 1 });

    const score = factsDb.calculateDiversityScore(fact.id);
    expect(score).toBeCloseTo(1.0, 2);

    // With diversityWeight=1.0, baseBoost=2: effectiveBoost = 2 * (0 + 1 * 1.0) = 2
    const diversityWeight = 1.0;
    const baseBoost = 2;
    const effectiveBoost = baseBoost * (1 - diversityWeight + diversityWeight * score);
    expect(effectiveBoost).toBeCloseTo(2.0, 2);

    // Apply the computed effective boost
    factsDb.reinforceFact(fact.id, "diverse boost", { querySnippet: "new query" }, { boostAmount: effectiveBoost });

    const all = factsDb.getAll({});
    const updated = all.find((f) => f.id === fact.id);
    // 2 initial boosts of 1 + effective boost ≈ 2 = total 4
    expect(updated?.reinforcedCount).toBeCloseTo(4, 1);
  });

  it("reinforceFact uses lower boost for repeated same-query reinforcements", () => {
    const fact = factsDb.store({
      text: "Repeated same context",
      category: "pattern",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Add 4 events all from same query → diversity = 1/4 = 0.25
    for (let i = 0; i < 4; i++) {
      factsDb.reinforceFact(fact.id, "same praise", { querySnippet: "same query" }, { boostAmount: 1 });
    }

    const score = factsDb.calculateDiversityScore(fact.id);
    expect(score).toBeCloseTo(0.25, 2);

    // With diversityWeight=1.0, baseBoost=1: effectiveBoost = 1 * (0 + 1 * 0.25) = 0.25
    const diversityWeight = 1.0;
    const baseBoost = 1;
    const effectiveBoost = baseBoost * (1 - diversityWeight + diversityWeight * score);
    expect(effectiveBoost).toBeLessThan(0.5);
  });
});

describe("Semantic dedup prevents duplicate pattern facts (#260)", () => {
  it("skips PATTERN_FACT when vectorDb.hasDuplicate returns true", async () => {
    const llmResponse = JSON.stringify([
      {
        category: "behavior",
        severity: "strong",
        remediationType: "PATTERN_FACT",
        remediationContent: {
          text: "User praises proactive fixes",
          tags: ["reinforcement", "behavioral"],
        },
      },
    ]);

    const openai = makeOpenAIMock(llmResponse);

    const sessionFile = join(tmpDir, "2026-01-01-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "I fixed the issue proactively." }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Great job! Love this approach." }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const ctx = makeCtx(openai, {
      cfg: {
        procedures: { sessionsDir: tmpDir },
        distill: {},
        reinforcement: {
          enabled: true,
          passiveBoost: 0.1,
          activeBoost: 0.05,
          maxConfidence: 1.0,
          similarityThreshold: 0.85,
          trackContext: true,
          maxEventsPerFact: 50,
        },
        selfCorrection: {
          semanticDedup: true,
          semanticDedupThreshold: 0.92,
          toolsSection: "Self-correction rules",
          applyToolsByDefault: true,
          autoRewriteTools: false,
          analyzeViaSpawn: false,
          spawnThreshold: 15,
          spawnModel: "",
          positiveRulesSection: "Positive Reinforcement Rules",
          reinforcementLLMAnalysis: true,
          reinforcementToProposals: true,
          agentsRuleToProposals: true,
        },
        llm: { default: ["test-model"], heavy: ["test-model"] },
        store: { classifyBeforeWrite: false },
        autoRecall: { enabled: false },
      } as any,
      vectorDb: {
        hasDuplicate: vi.fn().mockResolvedValue(true), // always a duplicate
        store: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    await runExtractReinforcementForCli(ctx, { workspace: tmpDir });

    // No facts should have been stored (dedup blocked it)
    const allFacts = factsDb.getAll({});
    const patternFact = allFacts.find((f) => f.category === "pattern");
    expect(patternFact).toBeUndefined();
  });
});
