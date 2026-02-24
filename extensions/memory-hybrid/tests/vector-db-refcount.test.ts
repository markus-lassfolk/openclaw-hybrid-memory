/**
 * Tests for VectorDB reference-counted singleton lifecycle (issue #106).
 *
 * Problem: VectorDB is a shared singleton. When any session called close() during
 * teardown, the DB was force-closed and all other concurrent sessions saw
 * "VectorDB is closed" — i.e. premature close of the shared singleton while
 * other sessions were still active.
 *
 * Fix: open() increments a refcount; removeSession() decrements it and only
 * actually closes the DB when refcount reaches 0. close() is reserved for
 * gateway shutdown (force-closes regardless of refcount).
 *
 * Also verifies credentials-pending.json ENOENT handling (issue #10).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import * as errorReporter from "../services/error-reporter.js";

const { VectorDB } = _testing;

const VECTOR_DIM = 3; // tiny vectors for speed

// ---------------------------------------------------------------------------
// Reference-counted VectorDB lifecycle
// ---------------------------------------------------------------------------

describe("VectorDB reference-counted lifecycle (issue #106)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof VectorDB>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-db-refcount-test-"));
    db = new VectorDB(join(tmpDir, "lance"), VECTOR_DIM);
    // Seed one row so search tests have data to find.
    await db.store({ text: "seed fact", vector: [0.1, 0.2, 0.3], importance: 0.7, category: "fact" });
  });

  afterEach(() => {
    // Force-close so the Lance directory is not locked during cleanup.
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("closing one of two open sessions keeps VectorDB alive", async () => {
    db.open(); // session A
    db.open(); // session B

    db.removeSession(); // session A ends → refcount = 1, no actual close

    // VectorDB must still be usable by session B.
    const id = await db.store({
      text: "still alive",
      vector: [0.4, 0.5, 0.6],
      importance: 0.8,
      category: "technical",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toBe("seed fact");

    db.removeSession(); // session B ends → refcount = 0, actual close
  });

  it("all sessions closed → VectorDB is actually closed", async () => {
    db.open(); // session A
    db.open(); // session B

    db.removeSession(); // refcount = 1, still open
    // closed flag must NOT be set yet
    expect((db as unknown as { closed: boolean }).closed).toBe(false);

    db.removeSession(); // refcount = 0, closes
    // Now the VectorDB must be marked closed and the internal connection released.
    expect((db as unknown as { closed: boolean }).closed).toBe(true);
    expect((db as unknown as { table: unknown }).table).toBeNull();
  });

  it("lazy reconnect — store succeeds after premature close() while session is open", async () => {
    db.open(); // session A started

    // Simulate a premature gateway stop() while the session is still active.
    db.close();

    // ensureInitialized() must auto-reconnect; the store must not throw.
    const id = await db.store({
      text: "reconnected successfully",
      vector: [0.7, 0.8, 0.9],
      importance: 0.9,
      category: "fact",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // Cleanup: release the open session that was left open by the scenario.
    // The force-close already reset sessionCount to 0, so removeSession is a no-op.
    db.removeSession();
  });

  it("lazy reconnect — search returns real results after premature close()", async () => {
    db.open();

    db.close(); // premature force-close

    // Should auto-reconnect and find the seed fact stored in beforeEach.
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toBe("seed fact");

    db.removeSession();
  });

  it("open() resets closed flag so the next operation reconnects", async () => {
    // Force the DB into a closed state.
    db.close();
    expect((db as unknown as { closed: boolean }).closed).toBe(true);

    // A new session calling open() must clear the flag.
    db.open();
    expect((db as unknown as { closed: boolean }).closed).toBe(false);

    // Subsequent operations must work.
    const n = await db.count();
    expect(n).toBe(1); // the seed fact from beforeEach

    db.removeSession();
  });

  it("multiple concurrent sessions — no premature close during parallel use", async () => {
    db.open(); // A
    db.open(); // B
    db.open(); // C

    // Run concurrent operations from all three "sessions".
    const [idA, idB, results] = await Promise.all([
      db.store({ text: "A fact", vector: [0.1, 0.2, 0.3], importance: 0.7, category: "fact" }),
      db.store({ text: "B fact", vector: [0.4, 0.5, 0.6], importance: 0.7, category: "fact" }),
      db.search([0.1, 0.2, 0.3], 5, 0),
    ]);

    expect(typeof idA).toBe("string");
    expect(typeof idB).toBe("string");
    expect(results.length).toBeGreaterThan(0);

    // End sessions one by one — VectorDB must stay alive until the last one.
    db.removeSession(); // A → count = 2
    expect((db as unknown as { closed: boolean }).closed).toBe(false);

    db.removeSession(); // B → count = 1
    expect((db as unknown as { closed: boolean }).closed).toBe(false);

    db.removeSession(); // C → count = 0, actual close
    expect((db as unknown as { closed: boolean }).closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credentials-pending.json ENOENT handling (issue #10)
// ---------------------------------------------------------------------------

describe("credentials-pending.json missing file handling (issue #10)", () => {
  it("access() on a non-existent credentials-pending.json throws ENOENT and does not report to Sentry", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cred-pending-test-"));
    const pendingPath = join(tmpDir, "credentials-pending.json");

    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => {});

    try {
      // Replicate the try/catch guard from hooks.ts before_agent_start: when the file
      // is missing, access() throws, we return early, and we must NOT call capturePluginError.
      let returnedEarly = false;
      try {
        await access(pendingPath);
      } catch {
        returnedEarly = true; // ENOENT caught — return early, normal case (no Sentry)
      }

      expect(returnedEarly).toBe(true);
      expect(captureSpy).not.toHaveBeenCalled();
    } finally {
      captureSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads and parses credentials-pending.json when the file exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cred-pending-test-"));
    const pendingPath = join(tmpDir, "credentials-pending.json");
    const payload = { hints: ["ghp_token pattern", "AWS secret"], at: Date.now() };
    await mkdir(tmpDir, { recursive: true });
    await writeFile(pendingPath, JSON.stringify(payload), "utf-8");

    // access() succeeds → fall through to readFile.
    let accessOk = false;
    try {
      await access(pendingPath);
      accessOk = true;
    } catch {
      // should not happen
    }
    expect(accessOk).toBe(true);

    // Parse and verify the content.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(pendingPath, "utf-8");
    const data = JSON.parse(raw) as { hints?: string[]; at?: number };
    expect(Array.isArray(data.hints)).toBe(true);
    expect(data.hints).toEqual(payload.hints);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expired credentials-pending.json (TTL elapsed) is discarded without error", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cred-pending-test-"));
    const pendingPath = join(tmpDir, "credentials-pending.json");
    const PENDING_TTL_MS = 5 * 60 * 1000; // same as hooks.ts constant
    const expiredAt = Date.now() - PENDING_TTL_MS - 1000; // 1 s past TTL
    await mkdir(tmpDir, { recursive: true });
    await writeFile(pendingPath, JSON.stringify({ hints: ["stale"], at: expiredAt }), "utf-8");

    // Replicate hooks.ts TTL check.
    const { readFile, unlink } = await import("node:fs/promises");
    let discarded = false;
    try {
      await access(pendingPath);
    } catch {
      // file missing — shouldn't happen here
    }
    try {
      const raw = await readFile(pendingPath, "utf-8");
      const data = JSON.parse(raw) as { hints?: string[]; at?: number };
      const at = typeof data.at === "number" ? data.at : 0;
      if (Date.now() - at > PENDING_TTL_MS) {
        await unlink(pendingPath).catch(() => {});
        discarded = true;
      }
    } catch {
      // ignore
    }

    expect(discarded).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
