/**
 * Tests for reinforcement extraction.
 */

import { describe, it, expect } from "vitest";
import { runReinforcementExtract } from "../services/reinforcement-extract.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("reinforcement-extract", () => {
  it("should detect explicit praise", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I checked the logs and found the error. Here's the fix."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Perfect! That's exactly what I needed"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.confidence).toBeGreaterThanOrEqual(0.7);
    expect(incident.agentBehavior).toContain("checked the logs");
    expect(incident.userMessage).toContain("Perfect");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract recalled memory IDs", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const memoryId = "12345678-1234-1234-1234-123456789abc";
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"memory_recall","id":"tool1"},{"type":"tool_result","tool_use_id":"tool1","content":"Found memory: ${memoryId}"},{"type":"text","text":"Based on that memory, here's my answer"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Brilliant! Exactly what I asked for"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.recalledMemoryIds.length).toBeGreaterThan(0);
    expect(incident.recalledMemoryIds).toContain(memoryId);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract tool call sequence (Phase 2)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"memory_recall","id":"tool1"},{"type":"tool_use","name":"exec","id":"tool2"},{"type":"tool_use","name":"write","id":"tool3"},{"type":"text","text":"Done! Fixed the config."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Spot on! Love this workflow"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.toolCallSequence.length).toBe(3);
    expect(incident.toolCallSequence).toEqual(["memory_recall", "exec", "write"]);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should filter out generic politeness", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Here's the info"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Thanks"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it|thanks?|thank you)\b/i,
    });

    // "Thanks" alone should be filtered out by confidence threshold (< 0.4)
    const highConfidence = result.incidents.filter((i) => i.confidence >= 0.4);
    expect(highConfidence.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect method confirmation", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I formatted the output as JSON"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Yes, like that! Keep this format"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.confidence).toBeGreaterThanOrEqual(0.75);
    expect(incident.userMessage).toContain("like that");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect relief/finally", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I've implemented the fix you wanted"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Finally! Now you get it"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.confidence).toBeGreaterThanOrEqual(0.8);
    expect(incident.userMessage).toContain("Finally");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should skip heartbeat and cron messages", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"HEARTBEAT_OK"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"great job"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Running cron job"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"perfect"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should boost confidence for substantial agent response", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const longResponse = "Here's a detailed analysis of the problem. ".repeat(10);
    const jsonl = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${longResponse}"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Great work!"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.confidence).toBeGreaterThanOrEqual(0.6); // Long response boosts confidence

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should collect tool calls from multiple assistant messages in multi-turn conversations", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-multiturn.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Fix the config"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"memory_recall","id":"tool1"},{"type":"text","text":"Let me check the memory"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"read","id":"tool2"},{"type":"text","text":"Reading the config file"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"write","id":"tool3"},{"type":"text","text":"Updated the config file"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Perfect! That workflow was exactly right"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runReinforcementExtract({
      filePaths: [sessionFile],
      reinforcementRegex: /\b(perfect|great|excellent|amazing|brilliant|spot on|nailed it|love it|much better|huge improvement|exactly|yes.*like that|keep.*this|finally|now you get it)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.toolCallSequence.length).toBe(3);
    expect(incident.toolCallSequence).toContain("memory_recall");
    expect(incident.toolCallSequence).toContain("read");
    expect(incident.toolCallSequence).toContain("write");
    expect(incident.agentBehavior).toContain("Updated the config file");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
