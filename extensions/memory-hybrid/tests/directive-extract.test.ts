/**
 * Tests for directive extraction (issue #39).
 */

import { describe, it, expect } from "vitest";
import { runDirectiveExtract, DIRECTIVE_CATEGORIES, isProceduraDirective, extractTaskIntentFromDirective } from "../services/directive-extract.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("directive-extract", () => {
  it("should detect explicit memory requests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Remember that I prefer dark mode"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Got it, I'll remember that."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.categories).toContain("explicit_memory");
    expect(incident.categories).toContain("preference");
    expect(incident.confidence).toBeGreaterThanOrEqual(0.7);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect future behavior changes", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"From now on, always check the logs before restart"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Will do."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.categories).toContain("future_behavior");
    expect(incident.categories).toContain("absolute_rule");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect procedural directives", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"First check the network before you restart the service"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Will do."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.categories).toContain("procedural");
    expect(isProceduraDirective(incident)).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect emotional emphasis", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpdir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"NEVER delete production data without backup!!!"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.categories).toContain("emotional_emphasis");
    expect(incident.categories).toContain("absolute_rule");
    expect(incident.confidence).toBeGreaterThanOrEqual(0.8);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should skip heartbeat and cron messages", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"heartbeat check"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"HEARTBEAT_OK"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"cron job reminder"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract task intent from procedural directive", () => {
    const directive1 = "Before you restart the service, check the logs";
    const intent1 = extractTaskIntentFromDirective(directive1, "");
    expect(intent1).toContain("restart the service");

    const directive2 = "First check the network status";
    const intent2 = extractTaskIntentFromDirective(directive2, "");
    expect(intent2).toContain("check the network status");

    const directive3 = "When the disk is full, delete old logs";
    const intent3 = extractTaskIntentFromDirective(directive3, "");
    expect(intent3).toContain("when the disk is full");
  });

  it("should handle multiple categories in one message", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"From now on, ALWAYS check logs before restart — remember that!"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    expect(incident.categories.length).toBeGreaterThan(1);
    expect(incident.categories).toContain("future_behavior");
    expect(incident.categories).toContain("absolute_rule");
    expect(incident.categories).toContain("explicit_memory");
    expect(incident.categories).toContain("emotional_emphasis");
    expect(incident.confidence).toBeGreaterThanOrEqual(0.8);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
