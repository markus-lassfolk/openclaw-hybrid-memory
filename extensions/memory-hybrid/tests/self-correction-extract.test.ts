import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSelfCorrectionExtract } from "../services/self-correction-extract.js";

function msg(role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  });
}

describe("self-correction-extract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "self-correction-test-"));
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("extracts incident when user message matches correction phrase", () => {
    const jsonl = [
      msg("assistant", "I ran the command without checking."),
      msg("user", "That was wrong — you should have verified first."),
      msg("assistant", "I will verify next time."),
    ].join("\n");
    const path = join(tmpDir, "2026-02-18-session.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /that was wrong|you should have|try again/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.sessionsScanned).toBe(1);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0].userMessage).toContain("That was wrong");
    expect(result.incidents[0].precedingAssistant).toContain("I ran the command");
    expect(result.incidents[0].followingAssistant).toContain("I will verify");
    expect(result.incidents[0].sessionFile).toBe("2026-02-18-session.jsonl");
    expect(result.incidents[0].timestamp).toBe("2026-02-18");
  });

  it("skips user message that matches skip filter (heartbeat)", () => {
    const jsonl = [
      msg("assistant", "Running heartbeat."),
      msg("user", "Heartbeat check — please confirm you are active."),
      msg("assistant", "I am active."),
    ].join("\n");
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /heartbeat|that was wrong/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.sessionsScanned).toBe(1);
    expect(result.incidents).toHaveLength(0);
  });

  it("skips very short user message even if it matches", () => {
    const jsonl = [
      msg("user", "try again"),
    ].join("\n");
    const path = join(tmpDir, "short.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /try again/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.incidents).toHaveLength(0);
  });

  it("returns empty when no user message matches correction regex", () => {
    const jsonl = [
      msg("user", "Please add a new feature to the dashboard."),
      msg("assistant", "I will add it."),
    ].join("\n");
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /that was wrong|you misunderstood/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.sessionsScanned).toBe(1);
    expect(result.incidents).toHaveLength(0);
  });

  it("truncates long user and assistant messages", () => {
    const longUser = "That was wrong. " + "word ".repeat(200);
    const jsonl = [
      msg("assistant", "x".repeat(600)),
      msg("user", longUser),
      msg("assistant", "y".repeat(600)),
    ].join("\n");
    const path = join(tmpDir, "long.jsonl");
    writeFileSync(path, jsonl, "utf-8");

    const re = /that was wrong/i;
    const result = runSelfCorrectionExtract({ filePaths: [path], correctionRegex: re });

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0].userMessage.length).toBeLessThanOrEqual(803);
    expect(result.incidents[0].precedingAssistant.length).toBeLessThanOrEqual(503);
    expect(result.incidents[0].followingAssistant.length).toBeLessThanOrEqual(503);
  });
});
