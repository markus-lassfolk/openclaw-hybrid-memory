import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../backends/event-log.js";

let tmpDir: string;
let eventLog: EventLog;
let archiveDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-log-archive-test-"));
  eventLog = new EventLog(join(tmpDir, "event-log.db"));
  archiveDir = join(tmpDir, "archive");
});

afterEach(() => {
  eventLog.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("EventLog archiveConsolidated", () => {
  it("archives consolidated events older than the cutoff into a gzipped JSONL file", async () => {
    const oldTs = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const recentTs = new Date().toISOString();

    const archivedId = eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Old consolidated event" },
      consolidatedInto: "fact-1",
    });

    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Old unconsolidated event" },
    });

    eventLog.append({
      sessionId: "s1",
      timestamp: recentTs,
      eventType: "fact_learned",
      content: { text: "Recent consolidated event" },
      consolidatedInto: "fact-2",
    });

    const result = await eventLog.archiveConsolidated(90, archiveDir);
    expect(result.archived).toBe(1);
    expect(result.files.length).toBe(1);

    const month = oldTs.slice(0, 7);
    const archivePath = join(archiveDir, `${month}.jsonl.gz`);
    expect(existsSync(archivePath)).toBe(true);

    const raw = gunzipSync(readFileSync(archivePath)).toString("utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as { id: string; consolidatedInto?: string };
    expect(parsed.id).toBe(archivedId);
    expect(parsed.consolidatedInto).toBe("fact-1");

    const remaining = eventLog.getBySession("s1", 10);
    expect(remaining.map((e) => e.id)).not.toContain(archivedId);
    expect(remaining).toHaveLength(2);
  });
});
