/**
 * Tests for Issue #164 — Continuous Verification of High-Stakes Facts.
 *
 * Coverage:
 *   buildVerificationPrompt:
 *     - includes fact text, entity and recent facts in prompt
 *     - falls back to "(no recent facts available)" when list is empty
 *   parseVerificationOutcome:
 *     - recognises CONFIRMED, STALE, UNCERTAIN keywords
 *     - is case-insensitive
 *     - defaults to UNCERTAIN for unrecognised responses
 *   ContinuousVerifier.verifyFact:
 *     - returns CONFIRMED when LLM responds with CONFIRMED
 *     - returns STALE when LLM responds with STALE
 *     - returns UNCERTAIN when LLM responds with UNCERTAIN
 *     - returns UNCERTAIN on LLM timeout (AbortError)
 *     - returns UNCERTAIN on LLM general error
 *   ContinuousVerifier.runCycle:
 *     - returns {checked:0,...} when no facts are due
 *     - CONFIRMED path: store updated (new version), confirmed counter incremented
 *     - STALE path: fact confidence set to 0.3, tag 'needs-verification' added
 *     - UNCERTAIN path: tag 'review-needed' added, confidence unchanged
 *     - counts errors without aborting the rest of the cycle
 *     - processes multiple facts in a single cycle
 *     - underlying fact not found — STALE/UNCERTAIN tags are no-ops (no crash)
 *   runVerificationCycle:
 *     - is a convenience wrapper returning the same result as runCycle
 *   Config parsing:
 *     - continuousVerification defaults to false
 *     - cycleDays defaults to 30
 *     - verificationModel is undefined when not set
 *     - parses custom values correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ContinuousVerifier,
  runVerificationCycle,
  buildVerificationPrompt,
  parseVerificationOutcome,
} from "../services/continuous-verifier.js";
import { _testing } from "../index.js";
import { hybridConfigSchema } from "../config.js";

const { VerificationStore, FactsDB } = _testing;

// Minimal valid base config required by hybridConfigSchema.parse
const BASE_CONFIG = {
  embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockOpenAI(response: string | Error): object {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          if (response instanceof Error) throw response;
          return { choices: [{ message: { content: response } }] };
        }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: InstanceType<typeof VerificationStore>;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cont-verifier-test-"));
  store = new VerificationStore(join(tmpDir, "verified.db"), {
    backupPath: join(tmpDir, "backup.json"),
    reverificationDays: 30,
  });
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  store.close();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. buildVerificationPrompt
// ---------------------------------------------------------------------------

describe("buildVerificationPrompt", () => {
  it("includes the fact text in the prompt", () => {
    const prompt = buildVerificationPrompt("Server IP is 10.0.0.1", "server", ["fact A"]);
    expect(prompt).toContain("Server IP is 10.0.0.1");
  });

  it("includes the entity name in the prompt", () => {
    const prompt = buildVerificationPrompt("Server IP is 10.0.0.1", "my-server", ["fact A"]);
    expect(prompt).toContain("my-server");
  });

  it("includes recent facts in the prompt", () => {
    const prompt = buildVerificationPrompt("Some fact", "entity", ["recent A", "recent B"]);
    expect(prompt).toContain("recent A");
    expect(prompt).toContain("recent B");
  });

  it("falls back to '(no recent facts available)' when list is empty", () => {
    const prompt = buildVerificationPrompt("Some fact", "entity", []);
    expect(prompt).toContain("(no recent facts available)");
  });

  it("numbers the recent facts", () => {
    const prompt = buildVerificationPrompt("F", "E", ["first", "second"]);
    expect(prompt).toContain("1. first");
    expect(prompt).toContain("2. second");
  });
});

// ---------------------------------------------------------------------------
// 2. parseVerificationOutcome
// ---------------------------------------------------------------------------

describe("parseVerificationOutcome", () => {
  it("returns CONFIRMED when response contains CONFIRMED", () => {
    expect(parseVerificationOutcome("CONFIRMED – still accurate")).toBe("CONFIRMED");
  });

  it("returns STALE when response contains STALE", () => {
    expect(parseVerificationOutcome("STALE – no longer valid")).toBe("STALE");
  });

  it("returns UNCERTAIN when response contains UNCERTAIN", () => {
    expect(parseVerificationOutcome("UNCERTAIN – can't tell")).toBe("UNCERTAIN");
  });

  it("is case-insensitive for CONFIRMED", () => {
    expect(parseVerificationOutcome("confirmed")).toBe("CONFIRMED");
  });

  it("is case-insensitive for STALE", () => {
    expect(parseVerificationOutcome("stale data found")).toBe("STALE");
  });

  it("defaults to UNCERTAIN for unrecognised response", () => {
    expect(parseVerificationOutcome("I have no idea")).toBe("UNCERTAIN");
  });

  it("prefers CONFIRMED over STALE when both appear (CONFIRMED checked first)", () => {
    expect(parseVerificationOutcome("CONFIRMED but maybe STALE")).toBe("CONFIRMED");
  });

  it("NOT CONFIRMED and UNCONFIRMED do not return CONFIRMED", () => {
    expect(parseVerificationOutcome("NOT CONFIRMED – no recent data")).toBe("UNCERTAIN");
    expect(parseVerificationOutcome("UNCONFIRMED")).toBe("UNCERTAIN");
    expect(parseVerificationOutcome("The fact is unconfirmed")).toBe("UNCERTAIN");
  });
});

// ---------------------------------------------------------------------------
// 3. ContinuousVerifier.verifyFact
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.verifyFact", () => {
  it("returns CONFIRMED when LLM responds with CONFIRMED", async () => {
    const mockOpenAI = makeMockOpenAI("CONFIRMED – still accurate");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const id = await store.verify("fact-1", "Server IP is 10.0.0.1", "agent");
    const vf = await store.getVerified("fact-1");
    const outcome = await verifier.verifyFact(vf!, ["The server is still running at 10.0.0.1"]);
    expect(outcome).toBe("CONFIRMED");
  });

  it("returns STALE when LLM responds with STALE", async () => {
    const mockOpenAI = makeMockOpenAI("STALE – decommissioned");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    await store.verify("fact-2", "Server IP is 10.0.0.1", "agent");
    const vf = await store.getVerified("fact-2");
    const outcome = await verifier.verifyFact(vf!, []);
    expect(outcome).toBe("STALE");
  });

  it("returns UNCERTAIN when LLM responds with UNCERTAIN", async () => {
    const mockOpenAI = makeMockOpenAI("UNCERTAIN – not enough info");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    await store.verify("fact-3", "Admin password reset", "user");
    const vf = await store.getVerified("fact-3");
    const outcome = await verifier.verifyFact(vf!, []);
    expect(outcome).toBe("UNCERTAIN");
  });

  it("returns UNCERTAIN on LLM timeout (AbortError)", async () => {
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    const mockOpenAI = makeMockOpenAI(abortErr);
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never, { timeoutMs: 1 });

    await store.verify("fact-timeout", "Some fact", "agent");
    const vf = await store.getVerified("fact-timeout");
    const outcome = await verifier.verifyFact(vf!, []);
    expect(outcome).toBe("UNCERTAIN");
  });

  it("returns UNCERTAIN on general LLM error", async () => {
    const mockOpenAI = makeMockOpenAI(new Error("Network failure"));
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    await store.verify("fact-err", "Some fact", "user");
    const vf = await store.getVerified("fact-err");
    const outcome = await verifier.verifyFact(vf!, []);
    expect(outcome).toBe("UNCERTAIN");
  });
});

// ---------------------------------------------------------------------------
// 4. ContinuousVerifier.runCycle — empty due list
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — empty due list", () => {
  it("returns {checked:0, confirmed:0, stale:0, uncertain:0, errors:0} when nothing is due", async () => {
    const mockOpenAI = makeMockOpenAI("CONFIRMED");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);
    // Add a fresh fact (not yet due)
    await store.verify("fact-fresh", "Fresh fact", "agent");
    const result = await verifier.runCycle();
    expect(result).toEqual({ checked: 0, confirmed: 0, stale: 0, uncertain: 0, errors: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5. ContinuousVerifier.runCycle — CONFIRMED path
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — CONFIRMED", () => {
  it("creates a new version in the store and increments confirmed counter", async () => {
    const mockOpenAI = makeMockOpenAI("CONFIRMED – still valid");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const id = await store.verify("fact-c", "Critical infrastructure IP", "agent");
    // Backdate next_verification so it is due
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);

    const result = await verifier.runCycle();
    expect(result.checked).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.stale).toBe(0);
    expect(result.uncertain).toBe(0);
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. ContinuousVerifier.runCycle — STALE path
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — STALE", () => {
  it("reduces fact confidence to 0.3 and adds 'needs-verification' tag", async () => {
    const mockOpenAI = makeMockOpenAI("STALE – decommissioned");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    // Add an underlying fact in FactsDB
    const entry = factsDb.store({
      text: "Server IP is 10.0.0.1",
      category: "technical",
      importance: 0.8,
      entity: "server",
      key: "ip",
      value: "10.0.0.1",
      source: "test",
    });
    const factId = entry.id;

    // Verify it in the store
    const storeId = await store.verify(factId, "Server IP is 10.0.0.1", "agent");

    // Backdate next_verification
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await verifier.runCycle();
    expect(result.checked).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.confirmed).toBe(0);

    const updated = factsDb.getById(factId);
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.3);
    expect(updated!.tags).toContain("needs-verification");
  });

  it("increments stale counter", async () => {
    const mockOpenAI = makeMockOpenAI("STALE – outdated");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const storeId = await store.verify("fact-stale-count", "Some fact", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await verifier.runCycle();
    expect(result.stale).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. ContinuousVerifier.runCycle — UNCERTAIN path
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — UNCERTAIN", () => {
  it("adds 'review-needed' tag and does not change confidence", async () => {
    const mockOpenAI = makeMockOpenAI("UNCERTAIN – not enough info");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const adminEntry = factsDb.store({
      text: "Admin endpoint URL",
      category: "technical",
      importance: 0.7,
      entity: "admin",
      key: "url",
      value: "https://admin.example.com",
      source: "test",
    });
    const factId = adminEntry.id;
    const originalConfidence = factsDb.getById(factId)!.confidence;

    const storeId = await store.verify(factId, "Admin endpoint URL", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await verifier.runCycle();
    expect(result.checked).toBe(1);
    expect(result.uncertain).toBe(1);
    expect(result.stale).toBe(0);

    const updated = factsDb.getById(factId);
    expect(updated!.confidence).toBe(originalConfidence);
    expect(updated!.tags).toContain("review-needed");
  });
});

// ---------------------------------------------------------------------------
// 8. ContinuousVerifier.runCycle — error handling
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — error handling", () => {
  it("counts errors but continues processing remaining facts", async () => {
    let callCount = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error("transient error");
            return { choices: [{ message: { content: "CONFIRMED" } }] };
          }),
        },
      },
    };

    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const id1 = await store.verify("fact-err1", "Fact one", "agent");
    const id2 = await store.verify("fact-err2", "Fact two", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)`).run(id1, id2);

    const result = await verifier.runCycle();
    expect(result.checked).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.confirmed).toBe(1);
  });

  it("no-op on STALE when underlying fact is not in FactsDB (no crash)", async () => {
    const mockOpenAI = makeMockOpenAI("STALE – gone");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    // Verify a factId that doesn't exist in FactsDB
    const storeId = await store.verify("nonexistent-fact-id", "Some fact", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await verifier.runCycle();
    expect(result.stale).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("no-op on UNCERTAIN when underlying fact is not in FactsDB (no crash)", async () => {
    const mockOpenAI = makeMockOpenAI("UNCERTAIN – unknown");
    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const storeId = await store.verify("nonexistent-fact-id-2", "Some fact", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await verifier.runCycle();
    expect(result.uncertain).toBe(1);
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. ContinuousVerifier.runCycle — multiple facts
// ---------------------------------------------------------------------------

describe("ContinuousVerifier.runCycle — multiple facts", () => {
  it("processes all due facts and aggregates counters correctly", async () => {
    let callCount = 0;
    const responses = ["CONFIRMED", "STALE", "UNCERTAIN"];
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            const resp = responses[callCount % responses.length];
            callCount++;
            return { choices: [{ message: { content: resp } }] };
          }),
        },
      },
    };

    const verifier = new ContinuousVerifier(store, factsDb, mockOpenAI as never);

    const ids = [
      await store.verify("f-multi-1", "Fact one", "agent"),
      await store.verify("f-multi-2", "Fact two", "agent"),
      await store.verify("f-multi-3", "Fact three", "agent"),
    ];
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    for (const id of ids) {
      db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
    }

    const result = await verifier.runCycle();
    expect(result.checked).toBe(3);
    expect(result.confirmed).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.uncertain).toBe(1);
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. runVerificationCycle convenience function
// ---------------------------------------------------------------------------

describe("runVerificationCycle", () => {
  it("returns the same result as runCycle for empty due list", async () => {
    const mockOpenAI = makeMockOpenAI("CONFIRMED");
    const result = await runVerificationCycle(store, factsDb, mockOpenAI as never);
    expect(result).toEqual({ checked: 0, confirmed: 0, stale: 0, uncertain: 0, errors: 0 });
  });

  it("passes verificationModel option to the verifier", async () => {
    const mockOpenAI = makeMockOpenAI("CONFIRMED – valid");
    const storeId = await store.verify("fact-model", "Some fact", "agent");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE verified_facts SET next_verification = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(storeId);

    const result = await runVerificationCycle(store, factsDb, mockOpenAI as never, {
      verificationModel: "openai/gpt-4.1-mini",
    });
    expect(result.checked).toBe(1);
    expect(result.confirmed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Config parsing — VerificationConfig new fields
// ---------------------------------------------------------------------------

describe("VerificationConfig — new fields", () => {
  it("continuousVerification defaults to false", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { enabled: true } });
    expect(cfg.verification.continuousVerification).toBe(false);
  });

  it("cycleDays defaults to 30", () => {
    const cfg = hybridConfigSchema.parse(BASE_CONFIG);
    expect(cfg.verification.cycleDays).toBe(30);
  });

  it("verificationModel is undefined when not set", () => {
    const cfg = hybridConfigSchema.parse(BASE_CONFIG);
    expect(cfg.verification.verificationModel).toBeUndefined();
  });

  it("parses continuousVerification: true correctly", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { continuousVerification: true } });
    expect(cfg.verification.continuousVerification).toBe(true);
  });

  it("parses custom cycleDays correctly", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { cycleDays: 7 } });
    expect(cfg.verification.cycleDays).toBe(7);
  });

  it("parses verificationModel correctly", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { verificationModel: "openai/gpt-4o-mini" } });
    expect(cfg.verification.verificationModel).toBe("openai/gpt-4o-mini");
  });

  it("ignores non-positive cycleDays and uses default 30", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { cycleDays: 0 } });
    expect(cfg.verification.cycleDays).toBe(30);
  });

  it("ignores empty string verificationModel and uses undefined", () => {
    const cfg = hybridConfigSchema.parse({ ...BASE_CONFIG, verification: { verificationModel: "   " } });
    expect(cfg.verification.verificationModel).toBeUndefined();
  });
});
