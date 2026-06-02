/**
 * Regression tests for #1823: failed strict audit runs must write a parseable structured failure
 * artifact instead of leaving final-audit.json empty/0 bytes.
 *
 * We test `buildAuditFailureArtifact` (the helper used by `runAuditHealth` in its error-handling
 * path), `buildAuditHealthExitInfo` (strict-failure contract), and the composition that
 * `runAuditHealth` performs when a report is available but strict mode fails.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAuditFailureArtifact,
  buildAuditHealthExitInfo,
  buildAuditHealthReport,
} from "../cli/commands/manage/register-storage-and-stats.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ─── buildAuditFailureArtifact ────────────────────────────────────────────────

describe("buildAuditFailureArtifact (#1823)", () => {
  it("returns a schema-consistent failure artifact from an Error", () => {
    const artifact = buildAuditFailureArtifact(new Error("DB connection lost"));

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.ok).toBe(false);
    expect(artifact.status).toBe("failed");
    expect(artifact.exitCode).toBe(2);
    expect(artifact.exitReason).toBe("strict_failed");
    expect(artifact.strictFailureReason).toBe("DB connection lost");
    expect(artifact.errorCount).toBe(1);
    expect(artifact.warningCount).toBe(0);
    expect(Array.isArray(artifact.errors)).toBe(true);
    expect(artifact.errors[0]).toMatchObject({ section: "audit-health", message: "DB connection lost" });
    expect(Array.isArray(artifact.warnings)).toBe(true);
    expect(artifact.warnings).toHaveLength(0);
    expect(artifact.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts a plain string error", () => {
    const artifact = buildAuditFailureArtifact("timeout exceeded");
    expect(artifact.strictFailureReason).toBe("timeout exceeded");
    expect(artifact.errors[0]?.message).toBe("timeout exceeded");
  });

  it("includes elapsedMs when provided", () => {
    const artifact = buildAuditFailureArtifact(new Error("fail"), 1234);
    expect(artifact.elapsedMs).toBe(1234);
  });

  it("omits elapsedMs when not provided", () => {
    const artifact = buildAuditFailureArtifact(new Error("fail"));
    expect("elapsedMs" in artifact).toBe(false);
  });

  it("produces valid JSON that round-trips through JSON.parse", () => {
    const artifact = buildAuditFailureArtifact(new Error("parse me"));
    const json = JSON.stringify(artifact);
    const parsed = JSON.parse(json) as typeof artifact;
    expect(parsed.ok).toBe(false);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.strictFailureReason).toBe("parse me");
  });
});

// ─── buildAuditHealthExitInfo — strict failure contract ──────────────────────

describe("buildAuditHealthExitInfo strict mode (#1823)", () => {
  it("returns exitCode 2 and strictFailureReason when strict=true and warnings present", () => {
    const info = buildAuditHealthExitInfo({ strict: true, warningCount: 3, errorCount: 0 });
    expect(info.exitCode).toBe(2);
    expect(info.exitReason).toBe("strict_warnings");
    expect(typeof info.strictFailureReason).toBe("string");
    expect(info.strictFailureReason).toContain("3 warning(s)");
  });

  it("returns exitCode 2 and strictFailureReason when strict=true and errors present", () => {
    const info = buildAuditHealthExitInfo({ strict: true, warningCount: 0, errorCount: 2 });
    expect(info.exitCode).toBe(2);
    expect(info.exitReason).toBe("strict_errors");
    expect(info.strictFailureReason).toContain("2 error(s)");
  });

  it("returns exitCode 2 when strict=true and ok=false with no explicit counts", () => {
    const info = buildAuditHealthExitInfo({ strict: true, warningCount: 0, errorCount: 0, ok: false });
    expect(info.exitCode).toBe(2);
    expect(info.exitReason).toBe("strict_failed");
    expect(typeof info.strictFailureReason).toBe("string");
  });

  it("returns exitCode 0 when strict=false even with warnings", () => {
    const info = buildAuditHealthExitInfo({ strict: false, warningCount: 5, errorCount: 0 });
    expect(info.exitCode).toBe(0);
    expect(info.exitReason).toBe("warnings");
    expect(info.strictFailureReason).toBeUndefined();
  });

  it("returns exitCode 0 when strict=true and health is clean", () => {
    const info = buildAuditHealthExitInfo({ strict: true, warningCount: 0, errorCount: 0, ok: true, status: "ok" });
    expect(info.exitCode).toBe(0);
    expect(info.exitReason).toBe("ok");
  });
});

// ─── Integration: strict failure produces a parseable artifact ───────────────

describe("strict audit failure artifact integration (#1823)", () => {
  it("JSON artifact has exitCode=2, strictFailureReason, and all required fields when warnings are present", () => {
    const db = new FactsDB(":memory:");
    // Insert a fact in an unconfigured category → generates an audit warning.
    db.store({
      text: "Unconfigured category test fact",
      category: "off-roster-unconfigured",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);
    const exitInfo = buildAuditHealthExitInfo({
      strict: true,
      warningCount: report.warningCount,
      errorCount: report.errorCount,
      ok: report.ok,
      status: report.status,
    });

    // This is the exact payload runAuditHealth emits when --json/--output is used.
    const artifact = {
      ...report,
      exitCode: exitInfo.exitCode,
      exitReason: exitInfo.exitReason,
      strictFailureReason: exitInfo.strictFailureReason,
    };
    const json = JSON.stringify(artifact, null, 2);

    expect(json.length).toBeGreaterThan(10);
    const parsed = JSON.parse(json) as typeof artifact;

    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(typeof parsed.exitReason).toBe("string");
    expect(typeof parsed.strictFailureReason).toBe("string");
    expect(parsed.warningCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(Array.isArray(parsed.errors)).toBe(true);

    db.close();
  });

  it("failure artifact from exception is non-empty valid JSON parseable by jq-style consumers", () => {
    const err = new Error("simulated buildAuditHealthReport failure");
    const artifact = buildAuditFailureArtifact(err, 42);
    const json = JSON.stringify(artifact, null, 2);

    expect(json.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json) as typeof artifact;

    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.generatedAt).toBe("string");
    expect(typeof parsed.strictFailureReason).toBe("string");
    expect(parsed.errorCount).toBeGreaterThanOrEqual(1);
    expect(typeof parsed.warningCount).toBe("number");
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.elapsedMs).toBe(42);
  });
});

// ─── --output atomic write: tmp+rename never leaves a 0-byte artifact ────────

describe("atomic artifact write semantics (#1823)", () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles) {
      for (const p of [f, `${f}.tmp`]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
    tmpFiles.length = 0;
  });

  it("writes valid JSON to the output path via tmp+rename, leaving no .tmp residue", () => {
    const outPath = join(tmpdir(), `audit-artifact-test-${Date.now()}.json`);
    tmpFiles.push(outPath);

    const artifact = buildAuditFailureArtifact(new Error("disk-write test"), 100);
    const json = JSON.stringify(artifact, null, 2);

    // Reproduce the atomic write that runAuditHealth performs with --output.
    const tmpPath = `${outPath}.tmp`;
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, outPath);

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);

    const content = readFileSync(outPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);

    const parsed = JSON.parse(content) as typeof artifact;
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.elapsedMs).toBe(100);
  });
});
