/**
 * Tests for trajectory learning (Issue #262 — Phase 2).
 */

import { describe, it, expect } from "vitest";
import {
  detectTrajectoryBoundaries,
  classifyTrajectoryOutcome,
  extractTrajectoryLessons,
  buildTrajectories,
  type TrajectoryTurn,
  type FeedbackTrajectory,
} from "../services/trajectory-tracker.js";
import type { ConversationTurn } from "../services/implicit-feedback-extract.js";

// ---------------------------------------------------------------------------
// detectTrajectoryBoundaries
// ---------------------------------------------------------------------------

describe("detectTrajectoryBoundaries", () => {
  it("returns empty for very short conversations", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];
    const boundaries = detectTrajectoryBoundaries(turns);
    expect(boundaries).toHaveLength(0);
  });

  it("detects single trajectory in a simple conversation", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I configure webpack for TypeScript?" },
      { role: "assistant", content: "Add ts-loader and tsconfig.json." },
      { role: "user", content: "How do I set up the webpack TypeScript compiler options?" },
      { role: "assistant", content: "Use the compilerOptions in tsconfig." },
      { role: "user", content: "Perfect, the webpack TypeScript setup is working now." },
    ];
    const boundaries = detectTrajectoryBoundaries(turns);
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
  });

  it("detects topic change as trajectory boundary", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I configure webpack for production builds with optimization?" },
      { role: "assistant", content: "Use mode: production and optimization settings." },
      { role: "user", content: "What webpack configuration do I need for production deployment?" },
      { role: "assistant", content: "Set mode to production in your config." },
      { role: "user", content: "Thanks, webpack is configured now." },
      // New completely different topic starts
      { role: "user", content: "Can you recommend a good recipe for pasta carbonara?" },
      { role: "assistant", content: "Classic carbonara uses eggs, pecorino, guanciale." },
      { role: "user", content: "What ingredients do I need for pasta carbonara sauce?" },
    ];
    const boundaries = detectTrajectoryBoundaries(turns);
    // Should detect at least 1 trajectory
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
  });

  it("closes trajectory at grateful message", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I deploy my application to kubernetes cluster?" },
      { role: "assistant", content: "Use kubectl apply -f deployment.yaml." },
      { role: "user", content: "Thanks, that worked perfectly!" }, // grateful close
      { role: "user", content: "Now I need to set up monitoring for my kubernetes pods and services." },
      { role: "assistant", content: "Use Prometheus and Grafana." },
      { role: "user", content: "How do I configure Prometheus monitoring for kubernetes services?" },
    ];
    const boundaries = detectTrajectoryBoundaries(turns);
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    // The first trajectory should end around the "Thanks" message
    expect(boundaries[0].startIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyTrajectoryOutcome
// ---------------------------------------------------------------------------

describe("classifyTrajectoryOutcome", () => {
  it("classifies 'success' when last user turn is positive with no corrections", () => {
    const turns: TrajectoryTurn[] = [
      { role: "user", content: "How do I deploy", summary: "How do I deploy", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "assistant", content: "Use kubectl", summary: "Use kubectl", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "user", content: "That worked great, thanks!", summary: "That worked great, thanks!", sentiment: "positive", wasCorrection: false, wasRephrase: false },
    ] as unknown as TrajectoryTurn[];
    const { outcome, signal } = classifyTrajectoryOutcome(turns);
    expect(outcome).toBe("success");
    expect(signal).toBe("positive_close");
  });

  it("classifies 'partial' when corrections happened but ends positively", () => {
    const turns: TrajectoryTurn[] = [
      { role: "user", summary: "deploy please", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "assistant", summary: "Here is the answer", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "user", summary: "No that is wrong", sentiment: "negative", wasCorrection: true, wasRephrase: false },
      { role: "assistant", summary: "Let me fix that", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "user", summary: "That worked thanks!", sentiment: "positive", wasCorrection: false, wasRephrase: false },
    ] as TrajectoryTurn[];
    const { outcome, signal, keyPivot } = classifyTrajectoryOutcome(turns);
    expect(outcome).toBe("partial");
    expect(signal).toBe("corrections_then_success");
    expect(keyPivot).toBe(4); // turn 4 is the positive one
  });

  it("classifies 'failure' when ends with correction", () => {
    const turns: TrajectoryTurn[] = [
      { role: "user", summary: "deploy this", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "assistant", summary: "Here is the result", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "user", summary: "Wrong, not what I asked for", sentiment: "negative", wasCorrection: true, wasRephrase: false },
    ] as TrajectoryTurn[];
    const { outcome, signal } = classifyTrajectoryOutcome(turns);
    expect(outcome).toBe("failure");
    expect(signal).toBe("ended_with_correction");
  });

  it("classifies 'failure' when user says they'll do it themselves", () => {
    const turns: TrajectoryTurn[] = [
      { role: "user", summary: "help me configure this", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "assistant", summary: "Sure, here is how", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
      { role: "user", summary: "Never mind, I'll do it myself", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
    ] as TrajectoryTurn[];
    const { outcome, signal } = classifyTrajectoryOutcome(turns);
    expect(outcome).toBe("failure");
    expect(signal).toBe("self_service_or_escalation");
  });

  it("returns failure for empty user turns", () => {
    const turns: TrajectoryTurn[] = [
      { role: "assistant", summary: "Here is the answer", sentiment: "neutral", wasCorrection: false, wasRephrase: false },
    ] as TrajectoryTurn[];
    const { outcome } = classifyTrajectoryOutcome(turns);
    expect(outcome).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// extractTrajectoryLessons
// ---------------------------------------------------------------------------

describe("extractTrajectoryLessons", () => {
  const base = (overrides: Partial<FeedbackTrajectory>): FeedbackTrajectory => ({
    id: "test-id",
    sessionFile: "test.jsonl",
    turns: [],
    outcome: "success",
    outcomeSignal: "positive_close",
    lessonsExtracted: [],
    topic: "webpack configuration",
    toolsUsed: [],
    turnCount: 3,
    ...overrides,
  });

  it("generates direct success lesson for short successful trajectory", () => {
    const traj = base({ outcome: "success", turnCount: 2, toolsUsed: ["exec", "write"] });
    const lessons = extractTrajectoryLessons(traj);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]).toContain("worked immediately");
    expect(lessons[0]).toContain("exec");
  });

  it("generates lesson about long successful trajectory", () => {
    const traj = base({ outcome: "success", turnCount: 8 });
    const lessons = extractTrajectoryLessons(traj);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]).toContain("8 turns");
  });

  it("generates pivot lesson for partial trajectory", () => {
    const pivotTurn: TrajectoryTurn = {
      role: "user",
      summary: "adding the TypeScript flag worked",
      sentiment: "positive",
      wasCorrection: false,
      wasRephrase: false,
    };
    const traj = base({
      outcome: "partial",
      outcomeSignal: "corrections_then_success",
      keyPivot: 3,
      turns: [
        { role: "user", summary: "deploy", sentiment: "neutral", wasCorrection: false, wasRephrase: false } as TrajectoryTurn,
        { role: "assistant", summary: "here", sentiment: "neutral", wasCorrection: false, wasRephrase: false } as TrajectoryTurn,
        { role: "user", summary: "wrong", sentiment: "negative", wasCorrection: true, wasRephrase: false } as TrajectoryTurn,
        pivotTurn,
      ],
    });
    const lessons = extractTrajectoryLessons(traj);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]).toContain("turn 3");
  });

  it("generates failure lesson with correction counts", () => {
    const traj = base({
      outcome: "failure",
      outcomeSignal: "ended_with_correction",
      turns: [
        { role: "user", summary: "request", sentiment: "neutral", wasCorrection: false, wasRephrase: false } as TrajectoryTurn,
        { role: "assistant", summary: "answer", sentiment: "neutral", wasCorrection: false, wasRephrase: false } as TrajectoryTurn,
        { role: "user", summary: "wrong", sentiment: "negative", wasCorrection: true, wasRephrase: false } as TrajectoryTurn,
        { role: "assistant", summary: "retry", sentiment: "neutral", wasCorrection: false, wasRephrase: false } as TrajectoryTurn,
        { role: "user", summary: "still wrong", sentiment: "negative", wasCorrection: true, wasRephrase: false } as TrajectoryTurn,
      ],
      turnCount: 5,
    });
    const lessons = extractTrajectoryLessons(traj);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]).toContain("2 correction");
  });
});

// ---------------------------------------------------------------------------
// buildTrajectories — integration
// ---------------------------------------------------------------------------

describe("buildTrajectories", () => {
  it("builds trajectories from a real conversation", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I configure webpack for TypeScript with decorators support?" },
      { role: "assistant", content: "You need ts-loader and tsconfig with experimentalDecorators." },
      { role: "user", content: "What typescript webpack configuration options do I need for decorators?" },
      { role: "assistant", content: "Enable experimentalDecorators in tsconfig.json." },
      { role: "user", content: "That worked, the webpack typescript config is set up now. Thanks!" },
    ];
    const trajectories = buildTrajectories(turns, "test-session.jsonl");
    expect(trajectories.length).toBeGreaterThanOrEqual(1);
    const traj = trajectories[0];
    expect(traj.sessionFile).toBe("test-session.jsonl");
    expect(traj.id).toBeTruthy();
    expect(traj.outcome).toBeDefined();
    expect(traj.lessonsExtracted.length).toBeGreaterThan(0);
  });

  it("returns empty array for too-short conversation", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const trajectories = buildTrajectories(turns, "short.jsonl");
    expect(trajectories).toHaveLength(0);
  });

  it("correctly identifies success outcome", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I set up webpack configuration for my project?" },
      { role: "assistant", content: "Create a webpack.config.js with entry and output." },
      { role: "user", content: "How do I configure webpack entry point and output path?" },
      { role: "assistant", content: "Set entry to src/index.js and output to dist." },
      { role: "user", content: "Perfect, that worked great! Thanks." },
    ];
    const trajectories = buildTrajectories(turns, "session.jsonl");
    expect(trajectories.length).toBeGreaterThanOrEqual(1);
    const successTraj = trajectories.find((t) => t.outcome === "success");
    expect(successTraj).toBeDefined();
  });

  it("assigns tools used from tool calls", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please deploy my application to the server" },
      { role: "assistant", content: "Deploying your app.", toolCalls: ["exec", "write"] },
      { role: "user", content: "Perfect, that worked great thanks." },
      { role: "assistant", content: "Great!" },
      { role: "user", content: "That was the best deployment experience." },
    ];
    const trajectories = buildTrajectories(turns, "deploy.jsonl");
    expect(trajectories.length).toBeGreaterThanOrEqual(1);
    const hasTool = trajectories.some((t) => t.toolsUsed.includes("exec") || t.toolsUsed.includes("write"));
    expect(hasTool).toBe(true);
  });
});
