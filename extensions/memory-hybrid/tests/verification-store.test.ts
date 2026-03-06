import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { _testing } from "../index.js";

const { VerificationStore, shouldAutoClassify, VerificationError } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: InstanceType<typeof VerificationStore>;
let backupPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verification-store-test-"));
  backupPath = join(tmpDir, "backup.json");
  store = new VerificationStore(join(tmpDir, "verified.db"), {
    backupPath,
    reverificationDays: 30,
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. verify — basic
// ---------------------------------------------------------------------------

describe("VerificationStore.verify", () => {
  it("returns a non-empty id", async () => {
    const id = await store.verify("fact-1", "The server IP is 10.0.0.1", "agent");
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("stores fact retrievable via getVerified", async () => {
    await store.verify("fact-2", "Admin password reset", "user");
    const vf = await store.getVerified("fact-2");
    expect(vf).not.toBeNull();
    expect(vf!.factId).toBe("fact-2");
    expect(vf!.canonicalText).toBe("Admin password reset");
    expect(vf!.verifiedBy).toBe("user");
  });

  it("computes and stores the correct SHA-256 checksum", async () => {
    const text = "Critical infrastructure fact";
    await store.verify("fact-3", text, "system");
    const vf = await store.getVerified("fact-3");
    expect(vf!.checksum).toBe(sha256(text));
  });

  it("sets version to 1 for initial entry", async () => {
    await store.verify("fact-4", "Some fact", "agent");
    const vf = await store.getVerified("fact-4");
    expect(vf!.version).toBe(1);
  });

  it("sets previousVersionId to null for initial entry", async () => {
    await store.verify("fact-5", "Another fact", "agent");
    const vf = await store.getVerified("fact-5");
    expect(vf!.previousVersionId).toBeNull();
  });

  it("sets nextVerification to approximately 30 days from now", async () => {
    const before = new Date();
    await store.verify("fact-6", "Test fact", "agent");
    const after = new Date();

    const vf = await store.getVerified("fact-6");
    const next = new Date(vf!.nextVerification!);
    const expectedMin = new Date(before.getTime() + 29 * 24 * 3600 * 1000);
    const expectedMax = new Date(after.getTime() + 31 * 24 * 3600 * 1000);
    expect(next >= expectedMin).toBe(true);
    expect(next <= expectedMax).toBe(true);
  });

  it("throws VerificationError when fact_id is already verified", async () => {
    await store.verify("fact-dup", "First", "agent");
    await expect(store.verify("fact-dup", "Second", "agent")).rejects.toThrow(VerificationError);
    const vf = await store.getVerified("fact-dup");
    expect(vf!.canonicalText).toBe("First");
  });

  it("accepts all three verifiedBy values", async () => {
    await store.verify("fact-a", "Text A", "agent");
    await store.verify("fact-b", "Text B", "user");
    await store.verify("fact-c", "Text C", "system");

    const a = await store.getVerified("fact-a");
    const b = await store.getVerified("fact-b");
    const c = await store.getVerified("fact-c");

    expect(a!.verifiedBy).toBe("agent");
    expect(b!.verifiedBy).toBe("user");
    expect(c!.verifiedBy).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// 2. getVerified — integrity check on retrieval
// ---------------------------------------------------------------------------

describe("VerificationStore.getVerified", () => {
  it("returns null for unknown factId", async () => {
    const result = await store.getVerified("nonexistent-fact");
    expect(result).toBeNull();
  });

  it("throws VerificationError when text is corrupted after storing", async () => {
    await store.verify("fact-corrupted", "Original text", "agent");

    // Directly corrupt the stored text in the DB
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `UPDATE verified_facts SET canonical_text = 'Tampered text' WHERE fact_id = ?`
    ).run("fact-corrupted");

    await expect(store.getVerified("fact-corrupted")).rejects.toThrow(VerificationError);
  });

  it("throws VerificationError whose message mentions the fact", async () => {
    await store.verify("important-fact", "Important data", "user");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `UPDATE verified_facts SET canonical_text = 'Changed' WHERE fact_id = ?`
    ).run("important-fact");

    await expect(store.getVerified("important-fact")).rejects.toThrow(/important-fact/);
  });
});

// ---------------------------------------------------------------------------
// 3. checkIntegrity
// ---------------------------------------------------------------------------

describe("VerificationStore.checkIntegrity", () => {
  it("returns valid=true and checked=0 for empty store", async () => {
    const report = await store.checkIntegrity();
    expect(report.valid).toBe(true);
    expect(report.checked).toBe(0);
  });

  it("returns valid=true when all stored facts are intact", async () => {
    await store.verify("f1", "Text 1", "agent");
    await store.verify("f2", "Text 2", "user");
    const report = await store.checkIntegrity();
    expect(report.valid).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.corrupted).toBeUndefined();
  });

  it("returns valid=false and lists corrupted ids when text is tampered", async () => {
    const id = await store.verify("f-tamper", "Original", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `UPDATE verified_facts SET canonical_text = 'Tampered' WHERE id = ?`
    ).run(id);

    const report = await store.checkIntegrity();
    expect(report.valid).toBe(false);
    expect(report.corrupted).toContain(id);
    expect(report.checked).toBe(1);
  });

  it("scopes integrity check to a single factId when specified", async () => {
    await store.verify("fact-ok", "Good text", "agent");
    const id2 = await store.verify("fact-bad", "Also good", "agent");

    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `UPDATE verified_facts SET canonical_text = 'Tampered' WHERE id = ?`
    ).run(id2);

    // Scoped to fact-ok — should be clean
    const reportOk = await store.checkIntegrity("fact-ok");
    expect(reportOk.valid).toBe(true);

    // Scoped to fact-bad — should be corrupted
    const reportBad = await store.checkIntegrity("fact-bad");
    expect(reportBad.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. update — versioning
// ---------------------------------------------------------------------------

describe("VerificationStore.update", () => {
  it("creates a new version entry with incremented version number", async () => {
    const id = await store.verify("fact-v", "Version 1", "agent");
    const newId = await store.update(id, "Version 2", "user");

    expect(newId).not.toBe(id);
    const vf = await store.getVerified("fact-v");
    expect(vf!.version).toBe(2);
    expect(vf!.canonicalText).toBe("Version 2");
  });

  it("links new version to the previous version via previousVersionId", async () => {
    const id = await store.verify("fact-link", "V1", "agent");
    const newId = await store.update(id, "V2", "user");

    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare(`SELECT * FROM verified_facts WHERE id = ?`).get(newId) as { previous_version_id: string | null };
    expect(row.previous_version_id).toBe(id);
  });

  it("old version remains accessible via direct id query", async () => {
    const id = await store.verify("fact-old", "Old text", "agent");
    await store.update(id, "New text", "user");

    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const oldRow = db.prepare(`SELECT * FROM verified_facts WHERE id = ?`).get(id) as { canonical_text: string };
    expect(oldRow.canonical_text).toBe("Old text");
  });

  it("clears next_verification on superseded version so listDueForReverification does not return it", async () => {
    const id = await store.verify("fact-super", "Original", "agent");
    await store.update(id, "Updated", "user");

    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const oldRow = db.prepare(`SELECT next_verification FROM verified_facts WHERE id = ?`).get(id) as { next_verification: string | null };
    expect(oldRow.next_verification).toBeNull();
  });

  it("throws VerificationError when updating a non-existent id", async () => {
    await expect(store.update("no-such-id", "text", "agent")).rejects.toThrow(VerificationError);
  });

  it("throws VerificationError when updating from a non-latest version", async () => {
    const id1 = await store.verify("fact-chain", "V1", "agent");
    const id2 = await store.update(id1, "V2", "user");
    await expect(store.update(id1, "V2-alt", "user")).rejects.toThrow(VerificationError);
    const vf = await store.getVerified("fact-chain");
    expect(vf!.canonicalText).toBe("V2");
    expect(vf!.id).toBe(id2);
  });

  it("update computes correct checksum for new text", async () => {
    const id = await store.verify("fact-cs", "Original", "agent");
    await store.update(id, "Updated text", "system");

    const vf = await store.getVerified("fact-cs");
    expect(vf!.checksum).toBe(sha256("Updated text"));
  });
});

// ---------------------------------------------------------------------------
// 5. listDueForReverification
// ---------------------------------------------------------------------------

describe("VerificationStore.listDueForReverification", () => {
  it("returns empty list when nothing is overdue", async () => {
    await store.verify("fact-fresh", "Fresh fact", "agent");
    const due = await store.listDueForReverification();
    expect(due).toHaveLength(0);
  });

  it("returns entries whose next_verification is in the past", async () => {
    // Store a fact then manually backdate its next_verification
    const id = await store.verify("fact-overdue", "Old fact", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(id);

    const due = await store.listDueForReverification();
    expect(due.length).toBeGreaterThan(0);
    const ids = due.map((d) => d.id);
    expect(ids).toContain(id);
  });

  it("does not include facts with future next_verification", async () => {
    await store.verify("fact-future", "Future fact", "agent");
    const due = await store.listDueForReverification();
    expect(due.every((d) => d.factId !== "fact-future")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. shouldAutoClassify
// ---------------------------------------------------------------------------

describe("shouldAutoClassify", () => {
  it("returns true for a fact containing an IP address", () => {
    expect(
      shouldAutoClassify({ text: "Server at 192.168.1.1", category: "fact", tags: [] })
    ).toBe(true);
  });

  it("returns true for various valid IPv4 addresses", () => {
    expect(shouldAutoClassify({ text: "Host: 10.0.0.1", category: "other", tags: [] })).toBe(true);
    expect(shouldAutoClassify({ text: "IP=172.16.254.1", category: "other", tags: [] })).toBe(true);
    expect(shouldAutoClassify({ text: "255.255.255.0 netmask", category: "other", tags: [] })).toBe(true);
  });

  it("returns true for infrastructure tag + technical category", () => {
    expect(
      shouldAutoClassify({
        text: "Load balancer config",
        category: "technical",
        tags: ["infrastructure"],
      })
    ).toBe(true);
  });

  it("returns false for plain fact without IP or infra tags", () => {
    expect(
      shouldAutoClassify({
        text: "User prefers dark mode",
        category: "preference",
        tags: [],
      })
    ).toBe(false);
  });

  it("returns false when infrastructure tag is present but category is not technical", () => {
    expect(
      shouldAutoClassify({
        text: "Load balancer",
        category: "fact",
        tags: ["infrastructure"],
      })
    ).toBe(false);
  });

  it("returns false when category is technical but infrastructure tag is absent", () => {
    expect(
      shouldAutoClassify({
        text: "Algorithm uses O(n log n)",
        category: "technical",
        tags: ["algorithm"],
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Backup file
// ---------------------------------------------------------------------------

describe("VerificationStore backup file", () => {
  it("creates backup file on first verify", async () => {
    await store.verify("fact-backup", "Backup test", "agent");
    expect(existsSync(backupPath)).toBe(true);
  });

  it("appends a JSON line per verify call", async () => {
    await store.verify("fact-b1", "Text 1", "agent");
    await store.verify("fact-b2", "Text 2", "user");
    const lines = readFileSync(backupPath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.some((p) => p.factId === "fact-b1")).toBe(true);
    expect(parsed.some((p) => p.factId === "fact-b2")).toBe(true);
  });

  it("appends a JSON line on update", async () => {
    const id = await store.verify("fact-upd", "Original", "agent");
    await store.update(id, "Updated", "system");
    const lines = readFileSync(backupPath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.some((p) => p.action === "update")).toBe(true);
  });

  it("each backup line has a ts timestamp field", async () => {
    await store.verify("fact-ts", "Timestamp test", "agent");
    const lines = readFileSync(backupPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ts).toBeDefined();
    expect(typeof parsed.ts).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 8. Config parsing (VerificationConfig defaults)
// ---------------------------------------------------------------------------

describe("VerificationConfig defaults", () => {
  it("uses reverificationDays=30 by default", async () => {
    const s = new VerificationStore(join(tmpDir, "default-config.db"), {
      backupPath: join(tmpDir, "default-backup.json"),
    });
    try {
      await s.verify("fact-cfg", "Config test", "agent");
      const vf = await s.getVerified("fact-cfg");
      const now = Date.now();
      const next = new Date(vf!.nextVerification!).getTime();
      const diffDays = (next - now) / (24 * 3600 * 1000);
      expect(diffDays).toBeGreaterThan(28);
      expect(diffDays).toBeLessThan(32);
    } finally {
      s.close();
    }
  });

  it("respects custom reverificationDays", async () => {
    const custom = new VerificationStore(join(tmpDir, "custom-rev.db"), {
      backupPath: join(tmpDir, "custom-backup.json"),
      reverificationDays: 7,
    });

    await custom.verify("fact-7d", "7-day reverification", "agent");
    const vf = await custom.getVerified("fact-7d");
    const next = new Date(vf!.nextVerification!).getTime();
    const diffDays = (next - Date.now()) / (24 * 3600 * 1000);
    expect(diffDays).toBeGreaterThan(5);
    expect(diffDays).toBeLessThan(9);
    custom.close();
  });
});
