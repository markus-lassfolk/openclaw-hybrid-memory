/**
 * Benchmark: frequency autosave (entity mention tracking)
 *
 * Tests: entity mention extraction + auto-save when threshold is met.
 *   - extractEntitiesFromText: find known-entity mentions in text
 *   - Shadow: compare search quality with mention frequency tracking vs without
 *
 * The "frequency autosave" feature means: when an entity is mentioned N times
 * in recent context, auto-save it as a fact. This benchmark measures the overhead
 * of tracking mention frequency vs not tracking.
 */

import type { BenchmarkContext, LatencyStats } from "../shadow-eval.js";
import { measureLatency, shadowMeasure } from "../shadow-eval.js";
import { FactsDB } from "../../backends/facts-db.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "bench-freq-"));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface FreqFixture {
  tmpDir: string;
  db: FactsDB;
  knownEntities: string[];
  sampleTexts: string[];
}

function createFixture(): FreqFixture {
  const tmpDir = makeTempDir();
  const db = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false });

  // Seed some known entity facts
  const entities = [
    { text: "Nibe is a Swedish HVAC system brand", entity: "Nibe", key: "type", value: "HVAC brand" },
    { text: "OpenClaw is the agent framework being used", entity: "OpenClaw", key: "type", value: "agent framework" },
    { text: "TypeScript is the language for this project", entity: "TypeScript", key: "language", value: "TypeScript" },
    { text: "Vitest is the testing framework", entity: "Vitest", key: "framework", value: "testing" },
    { text: "Markus is the user's name", entity: "Markus", key: "name", value: "user" },
  ];

  for (const e of entities) {
    db.store({
      text: e.text,
      category: "entity",
      importance: 0.8,
      entity: e.entity,
      key: e.key,
      value: e.value,
      source: "benchmark-seed",
    });
  }

  const knownEntities = db.getKnownEntities();
  const sampleTexts = [
    "I need to check the Nibe configuration for the heating system",
    "The TypeScript type errors are blocking the build — Nibe related",
    "Markus mentioned that Nibe systems need regular maintenance",
    "OpenClaw's TypeScript SDK makes it easy to work with Nibe APIs",
    "Using Vitest to write tests for the Nibe integration module",
    "Markus prefers TypeScript for its type safety benefits",
    "The OpenClaw plugin for Nibe fetches data every 5 minutes",
  ];

  return { tmpDir, db, knownEntities, sampleTexts };
}

// ---------------------------------------------------------------------------
// benchmark()
// ---------------------------------------------------------------------------

export function benchmark(_ctx: BenchmarkContext, iterations: number): LatencyStats {
  const fixture = createFixture();

  const trackFn = () => {
    let totalMentions = 0;
    for (const text of fixture.sampleTexts) {
      const mentions = fixture.db.extractEntitiesFromText(text, fixture.knownEntities);
      totalMentions += mentions.length;
    }
    return totalMentions;
  };

  fixture.db.close();
  rmSync(fixture.tmpDir, { recursive: true, force: true });

  const { p50, p95, p99, samples } = measureLatency(trackFn, iterations, 3);
  return { p50, p95, p99, samples };
}

// ---------------------------------------------------------------------------
// shadowBenchmark()
// ---------------------------------------------------------------------------

export function shadowBenchmark(
  _ctx: BenchmarkContext,
  iterations: number,
): { baselineStats: LatencyStats; shadowStats: LatencyStats; deltaMs: number } {
  const fixture = createFixture();

  // Shadow (with tracking): extract mentions from texts
  const withTracking = () => {
    let total = 0;
    for (const text of fixture.sampleTexts) {
      total += fixture.db.extractEntitiesFromText(text, fixture.knownEntities).length;
    }
    return total;
  };

  // Baseline (without tracking): just count words (no entity matching)
  const withoutTracking = () => {
    let total = 0;
    for (const text of fixture.sampleTexts) {
      total += text.split(/\s+/).length;
    }
    return total;
  };

  const result = shadowMeasure(withoutTracking, withTracking, iterations, 3);

  fixture.db.close();
  rmSync(fixture.tmpDir, { recursive: true, force: true });

  return result;
}

// ---------------------------------------------------------------------------
// testAccuracy()
// ---------------------------------------------------------------------------

export async function testAccuracy(
  _ctx: BenchmarkContext,
): Promise<{ featureOn: string; featureOff: string; prompt: string }> {
  const fixture = createFixture();

  const prompt = "User mentions Nibe, TypeScript, and Markus in conversation. Which entities were mentioned?";

  // Feature ON: track entity mentions
  const onMentions = fixture.db.extractEntitiesFromText(fixture.sampleTexts.join(" "), fixture.knownEntities);
  const featureOn = `Found ${onMentions.length} entity mentions: ${onMentions.map((m) => m.entity).join(", ")}`;

  // Feature OFF: no entity tracking (just split words)
  const wordCount = fixture.sampleTexts.join(" ").split(/\s+/).length;
  const featureOff = `Word count: ${wordCount} (no entity tracking)`;

  fixture.db.close();
  rmSync(fixture.tmpDir, { recursive: true, force: true });

  return { featureOn, featureOff, prompt };
}
