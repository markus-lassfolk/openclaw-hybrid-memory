/**
 * Benchmark: episodic memory (EventLog)
 *
 * Tests append / getBy* operations:
 *   - append: add a structured event to the session event log
 *   - getBySession / getByTimeRange: retrieve events
 *
 * Shadow mode: compare retrieval quality with events stored vs. not stored.
 */

import type { BenchmarkContext, LatencyStats } from "../shadow-eval.js";
import { measureLatency, shadowMeasure } from "../shadow-eval.js";
import { EventLog, categoryToEventType } from "../../backends/event-log.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "bench-episodes-"));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface EpisodeFixture {
  tmpDir: string;
  log: EventLog;
  sessionId: string;
  allSessions: string[];
}

function createFixture(): EpisodeFixture {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, "events.db");
  const log = new EventLog(dbPath);
  const sessionId = randomUUID();

  // Seed 20 events across 5 sessions
  const events = [
    { text: "User prefers dark mode for the editor", category: "preference" },
    { text: "Decided to use Vitest for unit testing", category: "decision" },
    { text: "Fixed bug in the FTS5 query builder", category: "action" },
    { text: "Entity 'Nibe' mentioned — Swedish HVAC system", category: "entity" },
    { text: "User works at a consulting company", category: "entity" },
    { text: "Reminder: review PR #272 tomorrow", category: "fact_learned" },
    { text: "Preference for bullet-point summaries", category: "preference" },
    { text: "Decision: use Redis for caching layer", category: "decision" },
    { text: "Action: deployed v2.3.1 to production", category: "action" },
    { text: "Entity 'OpenClaw' is the agent framework", category: "entity" },
    { text: "User timezone is Europe/Stockholm", category: "entity" },
    { text: "Preference for concise replies in group chats", category: "preference" },
    { text: "Decision: migrate to ONNX embeddings", category: "decision" },
    { text: "Action: updated dependencies in package.json", category: "action" },
    { text: "Entity 'Markus' is the user name", category: "entity" },
    { text: "Reminder: team meeting at 14:00", category: "fact_learned" },
    { text: "Preference for keyboard shortcuts over mouse", category: "preference" },
    { text: "Decision: adopt conventional commits", category: "decision" },
    { text: "Action: ran npm audit fix", category: "action" },
    { text: "Entity 'TypeScript' is the project language", category: "entity" },
  ];

  const sessions = Array.from({ length: 5 }, () => randomUUID());
  const now = new Date().toISOString();

  events.forEach((ev, i) => {
    log.append({
      sessionId: sessions[i % sessions.length],
      timestamp: now,
      eventType: categoryToEventType(ev.category),
      content: { text: ev.text, category: ev.category },
      entities: [],
    });
  });

  return { tmpDir, log, sessionId, allSessions: sessions };
}

/**
 * Filter events by searching for a query string in the content text.
 * Each word in the query must appear in the text.
 * This is the "search" operation for episodic events.
 */
function searchEventsByContent(log: EventLog, sessions: string[], query: string, limit: number) {
  const allEvents = sessions.flatMap((sid) => log.getBySession(sid, 1000));
  const terms = query.toLowerCase().split(/\s+/);
  return allEvents
    .filter((e) => {
      const text = ((e.content?.text as string | undefined) ?? "").toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// benchmark()
// ---------------------------------------------------------------------------

export function benchmark(_ctx: BenchmarkContext, iterations: number): LatencyStats {
  const fixture = createFixture();

  // Warm up
  const searchFn = () => searchEventsByContent(fixture.log, fixture.allSessions, "preference", 10);
  for (let i = 0; i < 3; i++) searchFn();

  const { p50, p95, p99, samples } = measureLatency(searchFn, iterations, 0);

  fixture.log.close();
  rmSync(fixture.tmpDir, { recursive: true, force: true });

  return { p50, p95, p99, samples };
}

// ---------------------------------------------------------------------------
// shadowBenchmark()
// ---------------------------------------------------------------------------

export function shadowBenchmark(
  _ctx: BenchmarkContext,
  iterations: number,
): { baselineStats: LatencyStats; shadowStats: LatencyStats; deltaMs: number } {
  // Shadow: with episodes stored
  const fixture = createFixture();
  const withEpisodes = () => searchEventsByContent(fixture.log, fixture.allSessions, "preference", 10);

  // Baseline: empty event log
  const baselineLog = new EventLog(join(fixture.tmpDir, "baseline.db"));
  const withoutEpisodes = () => searchEventsByContent(baselineLog, [randomUUID()], "preference", 10);

  const result = shadowMeasure(withoutEpisodes, withEpisodes, iterations, 3);

  fixture.log.close();
  baselineLog.close();
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

  const prompt = 'User asks: "What does the user prefer for summaries?"';

  // Feature ON: search events for "preference" + "summaries"
  const onEvents = searchEventsByContent(fixture.log, fixture.allSessions, "preference summaries", 5);
  const featureOn =
    onEvents.length > 0
      ? `Found ${onEvents.length} preference episodes. Most relevant: ${JSON.stringify(onEvents[0].content)}`
      : "No relevant episodes found.";

  // Feature OFF: empty log
  fixture.log.close();
  const offLog = new EventLog(join(fixture.tmpDir, "off.db"));
  const offEvents = searchEventsByContent(offLog, [randomUUID()], "preference summaries", 5);
  const featureOff =
    offEvents.length > 0 ? `Found ${offEvents.length} episodes` : "No relevant episodes found (episodes disabled).";
  offLog.close();
  rmSync(fixture.tmpDir, { recursive: true, force: true });

  return { featureOn, featureOff, prompt };
}
