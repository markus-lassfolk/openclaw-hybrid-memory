vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as errorReporter from "../services/error-reporter.js";
import { AliasDB } from "../services/retrieval-aliases.js";

function unitVec(dims = 4): number[] {
  const vector = new Array(dims).fill(0);
  vector[0] = 1;
  return vector;
}

describe("AliasDB LanceDB schema mismatch fallback", () => {
  let tmpDir: string;
  let aliasDb: AliasDB | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alias-schema-test-"));
    aliasDb = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    aliasDb?.close();
    // Allow pending LanceDB write transactions to flush before cleanup
    await new Promise((r) => setTimeout(r, 250));
    let retries = 5;
    while (retries-- > 0) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (retries === 0) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("falls back to linear search without reporting GlitchTip on known alias vector schema errors", async () => {
    aliasDb = new AliasDB(join(tmpDir, "aliases.db"), join(tmpDir, "aliases.lance"), 4);

    for (let index = 0; index < 10; index++) {
      aliasDb.store(randomUUID(), `alias-${index}`, unitVec());
    }
    (aliasDb as any).aliasCountCache = 1000;

    const knownSchemaErr = new Error(
      "Failed to execute query stream: GenericFailure, Invalid input, No vector column found to match with the query vector dimension",
    );

    const aliasIndex = (aliasDb as any).aliasIndex;
    await aliasIndex.search(unitVec(), 5, 0.1);
    aliasIndex.table = {
      vectorSearch: () => {
        throw knownSchemaErr;
      },
    };

    const results = await aliasDb.search(unitVec(), 5, 0.1);

    expect(results).toHaveLength(5);
    expect(results.every((result: { score: number }) => result.score > 0.9)).toBe(true);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AliasVectorIndex closed-state safety (issue #1494)
// ---------------------------------------------------------------------------

describe("AliasVectorIndex closed-state safety (issue #1494)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alias-closed-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Allow pending LanceDB write transactions to flush before cleanup
    await new Promise((r) => setTimeout(r, 250));
    let retries = 5;
    while (retries-- > 0) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (retries === 0) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("store() on a closed AliasVectorIndex does not call capturePluginError", async () => {
    const db = new AliasDB(join(tmpDir, "a.db"), join(tmpDir, "a.lance"), 4);
    const aliasIndex = (db as any).aliasIndex;

    // Close the vector index directly before any init has occurred
    aliasIndex.close();

    await aliasIndex.store({ id: randomUUID(), factId: randomUUID(), aliasText: "text", vector: unitVec() });

    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    db.close();
  });

  it("search() on a closed AliasVectorIndex does not call capturePluginError", async () => {
    const db = new AliasDB(join(tmpDir, "b.db"), join(tmpDir, "b.lance"), 4);
    const aliasIndex = (db as any).aliasIndex;

    aliasIndex.close();

    const results = await aliasIndex.search(unitVec(), 5, 0.1);

    expect(results).toEqual([]);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    db.close();
  });

  it("deleteByFactId() on a closed AliasVectorIndex does not call capturePluginError", async () => {
    const db = new AliasDB(join(tmpDir, "c.db"), join(tmpDir, "c.lance"), 4);
    const aliasIndex = (db as any).aliasIndex;

    aliasIndex.close();

    await aliasIndex.deleteByFactId(randomUUID());

    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    db.close();
  });

  it("ensureInitialized() does not restart initialization after close()", async () => {
    const db = new AliasDB(join(tmpDir, "d.db"), join(tmpDir, "d.lance"), 4);
    const aliasIndex = (db as any).aliasIndex;

    // Trigger init to succeed (open the table properly)
    await aliasIndex.store({ id: randomUUID(), factId: randomUUID(), aliasText: "seed", vector: unitVec() });

    // Now close the index directly
    aliasIndex.close();

    vi.clearAllMocks();

    // After close, a subsequent store() must not re-open the connection
    await aliasIndex.store({ id: randomUUID(), factId: randomUUID(), aliasText: "post-close", vector: unitVec() });

    // initPromise must remain null (closed guard fired; no new init was started)
    expect(aliasIndex.initPromise).toBeNull();
    // closed flag must still be true
    expect(aliasIndex.closed).toBe(true);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();

    db.close();
  });

  it("close() during in-flight doInitialize() leaves the index cleanly closed with no leaked resources", async () => {
    const db = new AliasDB(join(tmpDir, "e.db"), join(tmpDir, "e.lance"), 4);
    const aliasIndex = (db as any).aliasIndex;

    // Intercept doInitialize to simulate a slow async init
    let resolveInit: () => void = () => {};
    const initBarrier = new Promise<void>((res) => {
      resolveInit = res;
    });

    const origDoInit = aliasIndex.doInitialize.bind(aliasIndex);
    aliasIndex.doInitialize = async () => {
      await initBarrier;
      return origDoInit();
    };

    // Start store() — triggers ensureInitialized() → doInitialize() which blocks on initBarrier
    const storePromise = aliasIndex.store({
      id: randomUUID(),
      factId: randomUUID(),
      aliasText: "racing",
      vector: unitVec(),
    });

    // Close while init is blocked
    aliasIndex.close();

    // Unblock the init — doInitialize() will complete, then the .then() guard cleans up
    resolveInit();
    await storePromise;

    // After a close-during-init race, the index must be cleanly closed with no leaked resources
    expect(aliasIndex.closed).toBe(true);
    expect(aliasIndex.db).toBeNull();
    expect(aliasIndex.table).toBeNull();
    expect(aliasIndex.initPromise).toBeNull();

    // No spurious error reports
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();

    db.close();
  });
});
