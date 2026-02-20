/**
 * Tests for directive extraction.
 */

import { describe, it, expect } from "vitest";
import { runDirectiveExtract, DIRECTIVE_CATEGORIES } from "../services/directive-extract.js";
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

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect emotional emphasis", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-test.jsonl");
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

  it("extractRule should not use URL scheme colon (https:) as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-url.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Use https://docs.example.com for API. Remember: always use the v2 endpoint for writes."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Got it."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    // Rule should be taken from "Remember: ...", not from "https:"
    expect(incident.extractedRule).not.toMatch(/^\/\//);
    expect(incident.extractedRule.toLowerCase()).toContain("v2");
    expect(incident.extractedRule.toLowerCase()).toContain("endpoint");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use ftp: or other non-http URL schemes as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-ftp.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Use ftp://server.com for files. Remember: always use SFTP"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Got it."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBeGreaterThan(0);
    const incident = result.incidents[0];
    // Must extract "always use SFTP", not "//server.com for files..."
    expect(incident.extractedRule).not.toMatch(/^\/\//);
    expect(incident.extractedRule.toLowerCase()).toContain("sftp");
    expect(incident.extractedRule.toLowerCase()).toContain("always");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use mailto: scheme colon as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-mailto.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Send to mailto:admin@example.com. Remember: always BCC support"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Ok."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBe(1);
    // mailto: -> rule from "Remember: ...", not "admin@example.com..."
    expect(result.incidents[0].extractedRule.toLowerCase()).toContain("bcc");
    expect(result.incidents[0].extractedRule).not.toMatch(/^admin@/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should handle URI followed by directive without period separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-uri-edge.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"mailto:user@example.com Remember: this is important"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBe(1);
    // Verify the colon after "Remember" is correctly identified as directive separator
    // and not confused with the mailto: URI scheme colon
    expect(result.incidents[0].extractedRule.toLowerCase()).toContain("this is important");
    expect(result.incidents[0].extractedRule).not.toMatch(/^user@example\.com/);
    expect(result.incidents[0].extractedRule).not.toMatch(/^mailto/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use ssh: scheme colon as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-ssh.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Connect via ssh:host. Remember: always use key auth only"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Ok."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBe(1);
    // ssh: -> rule from "Remember: ...", not "host..."
    expect(result.incidents[0].extractedRule.toLowerCase()).toContain("key");
    expect(result.incidents[0].extractedRule).not.toMatch(/^host\./);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use data: scheme colon as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-data.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Data URI data:text/plain,hello. Remember: never trust unsanitized input"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Ok."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens)\b/i,
    });

    expect(result.incidents.length).toBe(1);
    // data: -> rule from "Remember: ...", not "text/plain..."
    expect(result.incidents[0].extractedRule.toLowerCase()).toContain("never");
    expect(result.incidents[0].extractedRule).not.toMatch(/^text\/plain/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use time formats or numbered lists as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-edge.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"At 14:30, remember: always check deploy logs before restart"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Step 1: backup data. Remember: never skip the backup step"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Got it."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Use ftp://server.com for uploads. Note: always verify checksums"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Will do."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens|note)\b/i,
    });

    expect(result.incidents.length).toBe(3);
    
    // First incident: time format should not be used as separator
    const incident1 = result.incidents[0];
    expect(incident1.extractedRule).not.toMatch(/^30/);
    expect(incident1.extractedRule.toLowerCase()).toContain("check");
    expect(incident1.extractedRule.toLowerCase()).toContain("deploy");
    
    // Second incident: numbered list should not be used as separator
    const incident2 = result.incidents[1];
    expect(incident2.extractedRule).not.toMatch(/^backup/);
    expect(incident2.extractedRule.toLowerCase()).toContain("never");
    expect(incident2.extractedRule.toLowerCase()).toContain("skip");
    
    // Third incident: ftp:// should not be used as separator
    const incident3 = result.incidents[2];
    expect(incident3.extractedRule).not.toMatch(/^\/\//);
    expect(incident3.extractedRule.toLowerCase()).toContain("verify");
    expect(incident3.extractedRule.toLowerCase()).toContain("checksum");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractRule should not use port numbers as directive separator", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
    const sessionFile = join(tmpDir, "2026-02-19-port.jsonl");
    const jsonl = `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Connect to localhost:8080 for testing. Remember: always use staging first"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Got it."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Deploy to server.com:21 via FTP. Note: never deploy on Fridays"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}`;
    writeFileSync(sessionFile, jsonl, "utf-8");

    const result = runDirectiveExtract({
      filePaths: [sessionFile],
      directiveRegex: /\b(remember|don't forget|keep in mind|from now on|always|never|i prefer|be careful|first check|no, use|when .* happens|note)\b/i,
    });

    expect(result.incidents.length).toBe(2);
    
    // First incident: localhost:8080 should not be used as separator
    const incident1 = result.incidents[0];
    expect(incident1.extractedRule).not.toMatch(/^8080/);
    expect(incident1.extractedRule.toLowerCase()).toContain("always");
    expect(incident1.extractedRule.toLowerCase()).toContain("staging");
    
    // Second incident: server.com:21 should not be used as separator
    const incident2 = result.incidents[1];
    expect(incident2.extractedRule).not.toMatch(/^21/);
    expect(incident2.extractedRule.toLowerCase()).toContain("never");
    expect(incident2.extractedRule.toLowerCase()).toContain("friday");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
