/**
 * Proactive research loop A3: the `research pick/store/status` CLI contract — the single
 * interface between the overnight cron agent and the memory store. pick hands out the queued
 * topic with its evidence chain and flips it in-progress; store validates everything (topic
 * state, body length, http(s) sources), writes the briefing with full provenance, and marks the
 * queue done; nothing else may write briefings.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerResearchGroup } from "../cli/commands/register-research-group.js";
import { parseResearchConfig } from "../config/parsers/research.js";
import { runResearchTrigger } from "../services/research-trigger.js";

type Action = (...args: unknown[]) => Promise<void>;

/** Minimal Chainable capturing "<group> <command>" → action. */
function makeFakeCli(): { registry: Map<string, Action>; root: unknown } {
  const registry = new Map<string, Action>();
  const make = (path: string): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    const self = () => node;
    node.command = (name: string) => make(path ? `${path} ${name}` : name);
    node.description = self;
    node.option = self;
    node.requiredOption = self;
    node.alias = self;
    node.action = (fn: Action) => {
      registry.set(path, fn);
      return node;
    };
    return node;
  };
  return { registry, root: make("") };
}

let dir: string;
let db: FactsDB;
let registry: Map<string, Action>;
let logs: string[];

const policy = { minImportance: 0.7, minEvidence: 1, cooldownDays: 14, maxPerNight: 1, topicBlocklist: [] };

function seedPickedTopic(): { insightId: string; evidenceId: string } {
  const evidenceId = db.store({
    text: "Working past midnight again, exhausted",
    entity: null,
    key: null,
    value: null,
    category: "fact",
    importance: 0.5,
    source: "test",
    tags: [],
  } as never).id;
  const insightId = db.store({
    text: "Insight: user repeatedly works past midnight and shows fatigue afterwards",
    entity: "insight:sleep-procrastination",
    key: "concern",
    value: "wellbeing",
    category: "insight",
    importance: 0.9,
    source: "insight-synthesis",
    tags: ["insight", "auto"],
    provenanceJson: JSON.stringify({
      method: "insight-synthesis",
      sourceFactIds: [evidenceId],
      sourceEventIds: [],
    }),
  } as never).id;
  const picked = runResearchTrigger(db, policy);
  expect(picked.picked).toBe(1);
  return { insightId, evidenceId };
}

function lastJson(): Record<string, unknown> {
  expect(logs.length).toBeGreaterThan(0);
  return JSON.parse(logs[logs.length - 1]) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-research-cli-"));
  db = new FactsDB(join(dir, "facts.db"));
  const fake = makeFakeCli();
  registry = fake.registry;
  const bindings = {
    factsDb: db,
    vectorDb: { store: async () => {} },
    embeddings: { embed: async () => [0.1, 0.2], modelName: "test-embed" },
    cfg: { research: parseResearchConfig({}) },
  };
  registerResearchGroup(fake.root as never, bindings as never);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("research pick", () => {
  it("returns status none on an empty queue", async () => {
    await registry.get("research pick")?.();
    expect(lastJson()).toEqual({ status: "none" });
  });

  it("returns the topic with hydrated evidence, flips it in-progress, and re-serves it within 24h", async () => {
    const { evidenceId } = seedPickedTopic();

    await registry.get("research pick")?.();
    const first = lastJson();
    expect(first.status).toBe("picked");
    expect(first.slug).toBe("sleep-procrastination");
    expect(String(first.insight)).toContain("works past midnight");
    expect(first.evidence).toEqual([{ id: evidenceId, text: "Working past midnight again, exhausted" }]);
    expect(first.maxBriefingChars).toBe(4000);

    const row = db.getRawDb().prepare("SELECT value FROM facts WHERE id = ?").get(String(first.topicId)) as {
      value: string;
    };
    expect(row.value).toBe("in-progress");

    await registry.get("research pick")?.();
    expect(lastJson().topicId).toBe(first.topicId); // same-night retry gets the same topic
  });

  it("includes pre-rendered goal/identity evidence alongside facts, with no extra reads needed", async () => {
    const evidenceId = db.store({
      text: "Working past midnight again, exhausted",
      entity: null,
      key: null,
      value: null,
      category: "fact",
      importance: 0.5,
      source: "test",
      tags: [],
    } as never).id;
    db.store({
      text: "Insight: user's active goal has stalled alongside late-night work",
      entity: "insight:goal-and-sleep",
      key: "concern",
      value: "growth",
      category: "insight",
      importance: 0.9,
      source: "insight-synthesis",
      tags: ["insight", "auto"],
      provenanceJson: JSON.stringify({
        method: "insight-synthesis",
        sourceFactIds: [evidenceId],
        sourceEventIds: [],
        sourceGoalEvidence: [{ id: "goal-1", text: 'Goal "ship v2" (priority: high, status: active, active 40d)' }],
        sourceIdentityEvidence: [{ id: "id-1", text: "[partnership] concise updates work best" }],
      }),
    } as never);
    expect(runResearchTrigger(db, policy).picked).toBe(1);

    await registry.get("research pick")?.();
    const out = lastJson();
    expect(out.evidence).toEqual([
      { id: evidenceId, text: "Working past midnight again, exhausted" },
      { id: "goal-1", text: 'Goal "ship v2" (priority: high, status: active, active 40d)' },
      { id: "id-1", text: "[partnership] concise updates work best" },
    ]);
  });

  it("ignores stale in-progress topics older than 24h", async () => {
    seedPickedTopic();
    await registry.get("research pick")?.();
    const topicId = String(lastJson().topicId);
    db.getRawDb().prepare("UPDATE facts SET created_at = created_at - 90000 WHERE id = ?").run(topicId);
    await registry.get("research pick")?.();
    expect(lastJson()).toEqual({ status: "none" });
  });
});

describe("research store", () => {
  async function pickTopicId(): Promise<string> {
    await registry.get("research pick")?.();
    return String(lastJson().topicId);
  }

  it("stores the briefing with the full provenance chain and marks the queue done", async () => {
    const { insightId, evidenceId } = seedPickedTopic();
    const topicId = await pickTopicId();
    const bodyPath = join(dir, "briefing.md");
    writeFileSync(
      bodyPath,
      "What I noticed: late nights. What I found: sleep procrastination is well studied. Suggestions: wind-down alarm. Sources below.",
    );

    await registry.get("research store")?.({
      topicId,
      sources: "https://example.org/paper, not-a-url, https://example.com/guide",
      file: bodyPath,
      title: "Sleep procrastination",
    });

    const out = lastJson();
    expect(out.status).toBe("stored");
    expect(out.sources).toBe(2); // invalid URL dropped
    const briefing = db
      .getRawDb()
      .prepare("SELECT text, entity, tags, provenance_json FROM facts WHERE category = 'briefing'")
      .get() as { text: string; entity: string; tags: string; provenance_json: string };
    expect(briefing.entity).toBe("briefing:sleep-procrastination");
    expect(briefing.text).toContain("Overnight research briefing");
    expect(briefing.text).toContain("Sleep procrastination");
    expect(briefing.tags).toContain("unread");
    const prov = JSON.parse(briefing.provenance_json);
    expect(prov.method).toBe("overnight-research");
    expect(prov.sourceFactIds).toEqual([insightId, topicId, evidenceId]);
    expect(prov.urls).toEqual(["https://example.org/paper", "https://example.com/guide"]);

    const queue = db.getRawDb().prepare("SELECT value FROM facts WHERE id = ?").get(topicId) as { value: string };
    expect(queue.value).toBe("done");

    // Done topic: a second store attempt is rejected, and pick finds nothing.
    await expect(
      registry.get("research store")?.({ topicId, sources: "https://example.org", file: bodyPath }),
    ).rejects.toThrow(/not picked\/in-progress/);
    await registry.get("research pick")?.();
    expect(lastJson()).toEqual({ status: "none" });
  });

  it("validates topic id, body length, and source URLs; caps body and sources", async () => {
    seedPickedTopic();
    const topicId = await pickTopicId();
    const bodyPath = join(dir, "briefing.md");
    writeFileSync(bodyPath, "x".repeat(10_000));

    await expect(
      registry.get("research store")?.({ topicId: "no-such-id", sources: "https://example.org", file: bodyPath }),
    ).rejects.toThrow(/not a research queue fact/);

    const shortPath = join(dir, "short.md");
    writeFileSync(shortPath, "too short");
    await expect(
      registry.get("research store")?.({ topicId, sources: "https://example.org", file: shortPath }),
    ).rejects.toThrow(/too short/);

    await expect(
      registry.get("research store")?.({ topicId, sources: "ftp://nope, garbage", file: bodyPath }),
    ).rejects.toThrow(/valid http\(s\) URL/);

    const manySources = Array.from({ length: 12 }, (_, i) => `https://example.org/s${i}`).join(",");
    await registry.get("research store")?.({ topicId, sources: manySources, file: bodyPath });
    const out = lastJson();
    expect(out.sources).toBe(8); // maxSources cap
    const briefing = db.getRawDb().prepare("SELECT text FROM facts WHERE category = 'briefing'").get() as {
      text: string;
    };
    expect(briefing.text.length).toBeLessThanOrEqual(4000 + 120); // body capped at maxBriefingChars (+ header line)
  });
});

describe("research status", () => {
  it("reports queue and briefings with unread flags", async () => {
    seedPickedTopic();
    const topicIdPromise = registry.get("research pick")?.();
    await topicIdPromise;
    const topicId = String(lastJson().topicId);
    const bodyPath = join(dir, "briefing.md");
    writeFileSync(bodyPath, "A briefing body long enough to pass the minimum length validation for storage.");
    await registry.get("research store")?.({ topicId, sources: "https://example.org", file: bodyPath });

    await registry.get("research status")?.({ json: true });
    const out = lastJson() as { queue: Array<{ status: string }>; briefings: Array<{ unread: boolean; slug: string }> };
    expect(out.queue[0]?.status).toBe("done");
    expect(out.briefings[0]).toMatchObject({ unread: true, slug: "sleep-procrastination" });
  });
});
