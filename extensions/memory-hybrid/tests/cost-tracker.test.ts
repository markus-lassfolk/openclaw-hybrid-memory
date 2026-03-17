import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { CostTracker } from "../backends/cost-tracker.js";
import { withCostFeature, getCurrentCostFeature } from "../services/cost-context.js";

function createInMemoryDb(): Database.Database {
  return new Database(":memory:");
}

describe("CostTracker", () => {
  let db: Database.Database;
  let tracker: CostTracker;

  beforeEach(() => {
    db = createInMemoryDb();
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("record()", () => {
    it("inserts a row into llm_cost_log", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 500,
        outputTokens: 100,
      });
      const row = db.prepare("SELECT * FROM llm_cost_log").get() as Record<string, unknown>;
      expect(row.feature).toBe("auto-classify");
      expect(row.model).toBe("openai/gpt-4.1-nano");
      expect(row.input_tokens).toBe(500);
      expect(row.output_tokens).toBe(100);
      expect(row.success).toBe(1);
    });

    it("records estimated_cost_usd for known model", () => {
      tracker.record({
        feature: "query-expansion",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      const row = db.prepare("SELECT estimated_cost_usd FROM llm_cost_log").get() as { estimated_cost_usd: number };
      // $0.10 + $0.40 = $0.50
      expect(row.estimated_cost_usd).toBeCloseTo(0.5, 4);
    });

    it("records null estimated_cost_usd for unknown model", () => {
      tracker.record({
        feature: "test-feature",
        model: "unknown/mystery-model",
        inputTokens: 100,
        outputTokens: 50,
      });
      const row = db.prepare("SELECT estimated_cost_usd FROM llm_cost_log").get() as {
        estimated_cost_usd: number | null;
      };
      expect(row.estimated_cost_usd).toBeNull();
    });

    it("records success=0 for failed calls", () => {
      tracker.record({
        feature: "distill",
        model: "openai/gpt-4o",
        inputTokens: 1000,
        outputTokens: 0,
        success: false,
      });
      const row = db.prepare("SELECT success FROM llm_cost_log").get() as {
        success: number;
      };
      expect(row.success).toBe(0);
    });

    it("records duration_ms when provided", () => {
      tracker.record({
        feature: "distill",
        model: "openai/gpt-4o",
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 1500,
      });
      const row = db.prepare("SELECT duration_ms FROM llm_cost_log").get() as {
        duration_ms: number;
      };
      expect(row.duration_ms).toBe(1500);
    });
  });

  describe("getReport()", () => {
    it("returns features aggregated by feature name", () => {
      // Insert several records
      for (let i = 0; i < 5; i++) {
        tracker.record({
          feature: "auto-classify",
          model: "openai/gpt-4.1-nano",
          inputTokens: 1000,
          outputTokens: 200,
        });
      }
      for (let i = 0; i < 3; i++) {
        tracker.record({
          feature: "query-expansion",
          model: "openai/gpt-4.1-nano",
          inputTokens: 500,
          outputTokens: 100,
        });
      }

      const report = tracker.getReport({ days: 1 });
      expect(report.features.length).toBe(2);
      const classifyFeature = report.features.find((f) => f.feature === "auto-classify");
      expect(classifyFeature).toBeDefined();
      expect(classifyFeature!.calls).toBe(5);
      expect(classifyFeature!.inputTokens).toBe(5000);
      expect(classifyFeature!.outputTokens).toBe(1000);
    });

    it("computes correct totals", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1000,
        outputTokens: 200,
      });
      tracker.record({
        feature: "query-expansion",
        model: "openai/gpt-4.1-nano",
        inputTokens: 500,
        outputTokens: 100,
      });

      const report = tracker.getReport({ days: 1 });
      expect(report.total.calls).toBe(2);
      expect(report.total.inputTokens).toBe(1500);
      expect(report.total.outputTokens).toBe(300);
    });

    it("filters by feature when specified", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1000,
        outputTokens: 200,
      });
      tracker.record({
        feature: "query-expansion",
        model: "openai/gpt-4.1-nano",
        inputTokens: 500,
        outputTokens: 100,
      });

      const report = tracker.getReport({ days: 1, feature: "auto-classify" });
      expect(report.features.length).toBe(1);
      expect(report.features[0]!.feature).toBe("auto-classify");
    });

    it("returns empty report when no data in window", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1000,
        outputTokens: 200,
      });

      // Set cutoff in the future — no records should match (days=0 means timestamp >= now)
      // Actually days=0 means cutoff is right now, so recent records might fall within it.
      // Use a negative scenario: override timestamp to past via raw SQL
      db.prepare("UPDATE llm_cost_log SET timestamp = 1000").run(); // epoch 1000 = ancient past
      const report = tracker.getReport({ days: 1 }); // last 1 day from now
      expect(report.features.length).toBe(0);
      expect(report.total.calls).toBe(0);
    });
  });

  describe("getModelBreakdown()", () => {
    it("aggregates by model", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1000,
        outputTokens: 200,
      });
      tracker.record({
        feature: "query-expansion",
        model: "openai/gpt-4.1-nano",
        inputTokens: 500,
        outputTokens: 100,
      });
      tracker.record({
        feature: "reflection",
        model: "openai/gpt-4o",
        inputTokens: 5000,
        outputTokens: 1000,
      });

      const breakdown = tracker.getModelBreakdown(1);
      expect(breakdown.length).toBe(2);
      const nanoRow = breakdown.find((b) => b.model === "openai/gpt-4.1-nano");
      expect(nanoRow).toBeDefined();
      expect(nanoRow!.calls).toBe(2);
    });
  });

  describe("getTotalCost()", () => {
    it("sums all records in the window", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 1000,
        outputTokens: 200,
      });
      tracker.record({
        feature: "reflection",
        model: "openai/gpt-4o",
        inputTokens: 5000,
        outputTokens: 1000,
      });

      const total = tracker.getTotalCost(1);
      expect(total.calls).toBe(2);
      expect(total.inputTokens).toBe(6000);
      expect(total.outputTokens).toBe(1200);
      expect(total.estimatedCostUsd).toBeGreaterThan(0);
    });

    it("returns zeros when no data", () => {
      const total = tracker.getTotalCost(1);
      expect(total.calls).toBe(0);
      expect(total.inputTokens).toBe(0);
      expect(total.outputTokens).toBe(0);
      expect(total.estimatedCostUsd).toBe(0);
    });
  });

  describe("pruneOldEntries()", () => {
    it("deletes entries older than retainDays", () => {
      // Insert a record with an ancient timestamp
      db.prepare(
        `INSERT INTO llm_cost_log (timestamp, feature, model, input_tokens, output_tokens, success)
         VALUES (1000, 'auto-classify', 'openai/gpt-4.1-nano', 100, 20, 1)`,
      ).run();
      // Insert a recent record
      tracker.record({
        feature: "recent",
        model: "openai/gpt-4.1-nano",
        inputTokens: 100,
        outputTokens: 20,
      });

      const deleted = tracker.pruneOldEntries(90);
      expect(deleted).toBe(1);

      const remaining = db.prepare("SELECT COUNT(*) AS n FROM llm_cost_log").get() as { n: number };
      expect(remaining.n).toBe(1);
    });

    it("returns 0 when nothing to prune", () => {
      tracker.record({
        feature: "auto-classify",
        model: "openai/gpt-4.1-nano",
        inputTokens: 100,
        outputTokens: 20,
      });
      const deleted = tracker.pruneOldEntries(90);
      expect(deleted).toBe(0);
    });
  });

  describe("record() error isolation", () => {
    it("does not throw when the DB is closed", () => {
      const tmpDb = new Database(":memory:");
      const tmpTracker = new CostTracker(tmpDb);
      tmpDb.close(); // close before recording
      // Should silently swallow — never let tracking break callers
      expect(() =>
        tmpTracker.record({
          feature: "test",
          model: "openai/gpt-4.1-nano",
          inputTokens: 1,
          outputTokens: 1,
        }),
      ).not.toThrow();
    });
  });

  describe("getReport() unknown model visibility", () => {
    it("reports unknownModelCalls and unknownModels for unrecognized models", () => {
      tracker.record({
        feature: "test",
        model: "unknown/mystery-model",
        inputTokens: 100,
        outputTokens: 50,
      });
      tracker.record({
        feature: "test",
        model: "openai/gpt-4.1-nano",
        inputTokens: 100,
        outputTokens: 50,
      });

      const report = tracker.getReport({ days: 1 });
      expect(report.unknownModelCalls).toBe(1);
      expect(report.unknownModels).toContain("unknown/mystery-model");
    });

    it("returns unknownModelCalls=0 when all models are recognized", () => {
      tracker.record({
        feature: "test",
        model: "openai/gpt-4.1-nano",
        inputTokens: 100,
        outputTokens: 50,
      });

      const report = tracker.getReport({ days: 1 });
      expect(report.unknownModelCalls).toBe(0);
      expect(report.unknownModels).toHaveLength(0);
    });
  });

  describe("cost-context AsyncLocalStorage integration", () => {
    it("withCostFeature provides label to getCurrentCostFeature", () => {
      let captured: string | undefined;
      withCostFeature("my-feature", () => {
        captured = getCurrentCostFeature();
      });
      expect(captured).toBe("my-feature");
    });

    it("getCurrentCostFeature returns undefined outside withCostFeature", () => {
      expect(getCurrentCostFeature()).toBeUndefined();
    });

    it("labels are scoped — outer label is restored after inner completes", () => {
      let inner: string | undefined;
      let outer: string | undefined;
      withCostFeature("outer", () => {
        withCostFeature("inner", () => {
          inner = getCurrentCostFeature();
        });
        outer = getCurrentCostFeature();
      });
      expect(inner).toBe("inner");
      expect(outer).toBe("outer");
    });

    it("records entry with feature label provided via withCostFeature (proxy simulation)", () => {
      // Simulate what the proxy does: record using the feature from context
      withCostFeature("auto-classify", () => {
        const feature = getCurrentCostFeature() ?? "unknown";
        tracker.record({
          feature,
          model: "openai/gpt-4.1-nano",
          inputTokens: 200,
          outputTokens: 50,
          success: true,
        });
      });
      const report = tracker.getReport({ days: 1 });
      expect(report.features[0]?.feature).toBe("auto-classify");
      expect(report.features[0]?.calls).toBe(1);
    });
  });

  describe("schema initialization", () => {
    it("creates the llm_cost_log table on construction", () => {
      const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cost_log'").get() as
        | { name: string }
        | undefined;
      expect(tableInfo).toBeDefined();
      expect(tableInfo!.name).toBe("llm_cost_log");
    });

    it("creates the llm_savings_log table on construction", () => {
      const tableInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_savings_log'")
        .get() as { name: string } | undefined;
      expect(tableInfo).toBeDefined();
      expect(tableInfo!.name).toBe("llm_savings_log");
    });

    it("creates the expected indexes", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_cost_log'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_cost_log_feature");
      expect(indexNames).toContain("idx_cost_log_timestamp");
    });

    it("creates the expected savings indexes", () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_savings_log'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_savings_log_feature");
      expect(indexNames).toContain("idx_savings_log_timestamp");
    });

    it("is idempotent — constructing twice does not throw", () => {
      expect(() => new CostTracker(db)).not.toThrow();
    });
  });

  describe("recordSavings()", () => {
    it("inserts a row into llm_savings_log", () => {
      tracker.recordSavings({
        feature: "self-correction",
        action: "auto-fixed incident",
        countAvoided: 3,
        estimatedSavingUsd: 0.006,
        note: "3 incidents auto-remediated",
      });
      const row = db.prepare("SELECT * FROM llm_savings_log").get() as Record<string, unknown>;
      expect(row.feature).toBe("self-correction");
      expect(row.action).toBe("auto-fixed incident");
      expect(row.count_avoided).toBe(3);
      expect(row.estimated_saving_usd).toBeCloseTo(0.006, 6);
      expect(row.note).toBe("3 incidents auto-remediated");
    });

    it("stores null note when note is omitted", () => {
      tracker.recordSavings({
        feature: "auto-classify",
        action: "batch-classified facts",
        countAvoided: 19,
        estimatedSavingUsd: 0.0019,
      });
      const row = db.prepare("SELECT note FROM llm_savings_log").get() as {
        note: string | null;
      };
      expect(row.note).toBeNull();
    });

    it("stores zero estimatedSavingUsd without throwing", () => {
      tracker.recordSavings({
        feature: "test-feature",
        action: "test action",
        countAvoided: 0,
        estimatedSavingUsd: 0,
      });
      const row = db.prepare("SELECT estimated_saving_usd FROM llm_savings_log").get() as {
        estimated_saving_usd: number;
      };
      expect(row.estimated_saving_usd).toBe(0);
    });
  });

  describe("getSavingsReport()", () => {
    it("returns empty report when no savings recorded", () => {
      const report = tracker.getSavingsReport(7);
      expect(report.features).toHaveLength(0);
      expect(report.total.entries).toBe(0);
      expect(report.total.countAvoided).toBe(0);
      expect(report.total.estimatedSavingUsd).toBe(0);
      expect(report.days).toBe(7);
    });

    it("aggregates savings by feature", () => {
      tracker.recordSavings({
        feature: "self-correction",
        action: "auto-fixed incident",
        countAvoided: 2,
        estimatedSavingUsd: 0.004,
      });
      tracker.recordSavings({
        feature: "self-correction",
        action: "auto-fixed incident",
        countAvoided: 1,
        estimatedSavingUsd: 0.002,
      });
      tracker.recordSavings({
        feature: "auto-classify",
        action: "batch-classified facts",
        countAvoided: 19,
        estimatedSavingUsd: 0.0019,
      });

      const report = tracker.getSavingsReport(7);
      expect(report.features).toHaveLength(2);

      const sc = report.features.find((f) => f.feature === "self-correction");
      expect(sc).toBeDefined();
      expect(sc!.entries).toBe(2);
      expect(sc!.countAvoided).toBe(3);
      expect(sc!.estimatedSavingUsd).toBeCloseTo(0.006, 6);

      const ac = report.features.find((f) => f.feature === "auto-classify");
      expect(ac).toBeDefined();
      expect(ac!.entries).toBe(1);
      expect(ac!.countAvoided).toBe(19);
    });

    it("computes correct totals", () => {
      tracker.recordSavings({
        feature: "self-correction",
        action: "fix",
        countAvoided: 5,
        estimatedSavingUsd: 0.01,
      });
      tracker.recordSavings({
        feature: "reflection",
        action: "pattern",
        countAvoided: 10,
        estimatedSavingUsd: 0.005,
      });

      const report = tracker.getSavingsReport(7);
      expect(report.total.entries).toBe(2);
      expect(report.total.countAvoided).toBe(15);
      expect(report.total.estimatedSavingUsd).toBeCloseTo(0.015, 6);
    });

    it("respects the days window", () => {
      // Inject an old entry directly with an old timestamp
      db.prepare(
        "INSERT INTO llm_savings_log (timestamp, feature, action, count_avoided, estimated_saving_usd) VALUES (?, ?, ?, ?, ?)",
      ).run(Math.floor(Date.now() / 1000) - 10 * 86400, "old-feature", "old action", 5, 0.005);

      tracker.recordSavings({
        feature: "new-feature",
        action: "new action",
        countAvoided: 2,
        estimatedSavingUsd: 0.002,
      });

      const report7 = tracker.getSavingsReport(7);
      expect(report7.features.map((f) => f.feature)).not.toContain("old-feature");
      expect(report7.features.map((f) => f.feature)).toContain("new-feature");

      const report30 = tracker.getSavingsReport(30);
      expect(report30.features.map((f) => f.feature)).toContain("old-feature");
      expect(report30.features.map((f) => f.feature)).toContain("new-feature");
    });

    it("orders features by estimatedSavingUsd descending", () => {
      tracker.recordSavings({
        feature: "cheap-feature",
        action: "a",
        countAvoided: 1,
        estimatedSavingUsd: 0.001,
      });
      tracker.recordSavings({
        feature: "expensive-feature",
        action: "b",
        countAvoided: 10,
        estimatedSavingUsd: 0.05,
      });

      const report = tracker.getSavingsReport(7);
      expect(report.features[0]!.feature).toBe("expensive-feature");
      expect(report.features[1]!.feature).toBe("cheap-feature");
    });
  });

  describe("pruneOldEntries() — extended", () => {
    it("also prunes llm_savings_log entries older than retainDays", () => {
      // Old savings entry
      db.prepare(
        "INSERT INTO llm_savings_log (timestamp, feature, action, count_avoided, estimated_saving_usd) VALUES (?, ?, ?, ?, ?)",
      ).run(Math.floor(Date.now() / 1000) - 100 * 86400, "old", "x", 1, 0.001);
      // Recent savings entry
      tracker.recordSavings({
        feature: "recent",
        action: "y",
        countAvoided: 1,
        estimatedSavingUsd: 0.001,
      });

      const pruned = tracker.pruneOldEntries(90);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const remaining = db.prepare("SELECT feature FROM llm_savings_log").all() as Array<{ feature: string }>;
      expect(remaining.map((r) => r.feature)).not.toContain("old");
      expect(remaining.map((r) => r.feature)).toContain("recent");
    });
  });
});
