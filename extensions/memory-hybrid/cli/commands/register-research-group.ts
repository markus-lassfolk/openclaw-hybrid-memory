/**
 * `research` CLI group (proactive research loop A3 — docs/PROACTIVE-RESEARCH.md).
 *
 * The contract between the overnight cron agent and the memory store:
 *   - `research pick --json`  → hands the agent tonight's queued topic + the evidence chain
 *     (or {"status":"none"}), flipping the queue fact to in-progress.
 *   - `research store`        → the SINGLE writer for briefing facts: validates the topic,
 *     caps length/sources, records provenance (insight + queue + evidence + URLs), embeds
 *     best-effort, and marks the queue fact done.
 *   - `research status`       → operator audit view: queue, briefings, and evidence counts.
 */
import { readFileSync } from "node:fs";
import { capturePluginError } from "../../services/error-reporter.js";
import { parseTags } from "../../utils/tags.js";
import { type Chainable, withExit } from "../shared.js";
import { createCommandGroup } from "./cli-group-utils.js";
import type { ManageBindings } from "./manage/bindings.js";

interface QueueFactRow {
  id: string;
  entity: string;
  value: string;
  text: string;
  provenance_json: string | null;
  created_at: number;
}

interface EvidenceItem {
  id: string;
  text: string;
}

function parseSourceFactIds(provenanceJson: string | null): string[] {
  if (!provenanceJson) return [];
  try {
    const parsed = JSON.parse(provenanceJson) as { sourceFactIds?: unknown };
    return Array.isArray(parsed.sourceFactIds)
      ? parsed.sourceFactIds.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function parseSourceEventIds(provenanceJson: string | null): string[] {
  if (!provenanceJson) return [];
  try {
    const parsed = JSON.parse(provenanceJson) as { sourceEventIds?: unknown };
    return Array.isArray(parsed.sourceEventIds)
      ? parsed.sourceEventIds.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Walk queue fact → insight → evidence facts/signals into displayable items. */
function hydrateEvidence(
  b: ManageBindings,
  insightId: string | null,
): { insight: string | null; evidence: EvidenceItem[] } {
  if (!insightId) return { insight: null, evidence: [] };
  const insight = b.factsDb.getById(insightId);
  if (!insight) return { insight: null, evidence: [] };
  const evidence: EvidenceItem[] = [];
  for (const factId of parseSourceFactIds(insight.provenanceJson ?? null).slice(0, 10)) {
    const fact = b.factsDb.getById(factId);
    if (fact) evidence.push({ id: factId, text: fact.text.replace(/\s+/g, " ").slice(0, 240) });
  }
  for (const eventRef of parseSourceEventIds(insight.provenanceJson ?? null).slice(0, 10)) {
    const signalId = Number.parseInt(eventRef.replace(/^implicit_signal:/, ""), 10);
    if (!Number.isFinite(signalId)) continue;
    const row = b.factsDb
      .getRawDb()
      .prepare("SELECT signal_type, user_message FROM implicit_signals WHERE id = ?")
      .get(signalId) as { signal_type: string; user_message: string | null } | undefined;
    if (row) {
      evidence.push({
        id: eventRef,
        text: `[${row.signal_type}] ${(row.user_message ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
      });
    }
  }
  return { insight: insight.text, evidence };
}

function findActiveQueueFact(b: ManageBindings, nowSec: number): QueueFactRow | null {
  const rows = b.factsDb
    .getRawDb()
    .prepare(
      `SELECT id, entity, value, text, provenance_json, created_at FROM facts
        WHERE category = 'ops_status' AND entity LIKE 'research:%' AND key = 'status'
          AND value IN ('picked', 'in-progress') AND superseded_at IS NULL
        ORDER BY created_at DESC LIMIT 5`,
    )
    .all() as unknown as QueueFactRow[];
  for (const row of rows) {
    // A stale in-progress topic (>24h) means an earlier run died mid-research; leave it for
    // `research status` to surface rather than silently re-running old concerns forever.
    if (row.value === "in-progress" && nowSec - row.created_at > 24 * 3600) continue;
    return row;
  }
  return null;
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerResearchGroup(mem: Chainable, b: ManageBindings): void {
  const research = createCommandGroup(
    mem,
    "research",
    "Proactive research loop: overnight topic pick, briefing storage, audit (docs/PROACTIVE-RESEARCH.md)",
  );

  research
    .command("pick")
    .description("Fetch tonight's queued research topic with its evidence chain (agent-facing; JSON output)")
    .option("--json", "Output JSON (default)")
    .action(
      withExit(async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const queue = findActiveQueueFact(b, nowSec);
        if (!queue) {
          console.log(JSON.stringify({ status: "none" }));
          return;
        }
        const slug = queue.entity.slice("research:".length);
        const insightId = parseSourceFactIds(queue.provenance_json)[0] ?? null;
        const { insight, evidence } = hydrateEvidence(b, insightId);
        if (queue.value !== "in-progress") {
          b.factsDb.getRawDb().prepare("UPDATE facts SET value = 'in-progress' WHERE id = ?").run(queue.id);
        }
        console.log(
          JSON.stringify({
            status: "picked",
            topicId: queue.id,
            slug,
            insight: insight ?? queue.text,
            evidence,
            guidance:
              "Research what is known about this pattern and what credibly helps. Store findings with `openclaw hybrid-mem research store` — that command is the only allowed write path.",
            maxBriefingChars: b.cfg.research.executor.maxBriefingChars,
          }),
        );
      }),
    );

  research
    .command("store")
    .description("Store an overnight research briefing for a picked topic (single writer; agent-facing)")
    .requiredOption("--topic-id <id>", "Queue fact id returned by `research pick`")
    .requiredOption("--sources <urls>", "Comma-separated http(s) source URLs backing the briefing")
    .option("--file <path>", "Read the briefing body from a file")
    .option("--stdin", "Read the briefing body from stdin")
    .option("--title <title>", "Short briefing title")
    .action(
      withExit(async (opts: { topicId: string; sources: string; file?: string; stdin?: boolean; title?: string }) => {
        const queue = b.factsDb.getById(opts.topicId);
        const rawQueue = b.factsDb
          .getRawDb()
          .prepare("SELECT entity, key, value FROM facts WHERE id = ? AND category = 'ops_status'")
          .get(opts.topicId) as { entity: string | null; key: string | null; value: string | null } | undefined;
        if (!queue || !rawQueue?.entity?.startsWith("research:") || rawQueue.key !== "status") {
          throw new Error(`research store: --topic-id ${opts.topicId} is not a research queue fact`);
        }
        if (rawQueue.value !== "in-progress" && rawQueue.value !== "picked") {
          throw new Error(`research store: topic ${opts.topicId} is '${rawQueue.value}', not picked/in-progress`);
        }
        if (!opts.file && !opts.stdin) {
          throw new Error("research store: provide the briefing body via --file <path> or --stdin");
        }
        const bodyRaw = opts.file ? readFileSync(opts.file, "utf8") : readFileSync(0, "utf8");
        const maxChars = b.cfg.research.executor.maxBriefingChars;
        const body = bodyRaw.trim().slice(0, maxChars);
        if (body.length < 40) {
          throw new Error("research store: briefing body is too short to be a real briefing (min 40 chars)");
        }
        const urls = opts.sources
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && isValidHttpUrl(s))
          .slice(0, b.cfg.research.executor.maxSources);
        if (urls.length === 0) {
          throw new Error("research store: --sources must contain at least one valid http(s) URL");
        }

        const slug = rawQueue.entity.slice("research:".length);
        const insightId = parseSourceFactIds(queue.provenanceJson ?? null)[0] ?? null;
        const evidenceFactIds = insightId
          ? parseSourceFactIds(b.factsDb.getById(insightId)?.provenanceJson ?? null)
          : [];
        const dateUtc = new Date().toISOString().slice(0, 10);
        const title = (opts.title ?? slug.replace(/-/g, " ")).trim().slice(0, 120);

        const briefing = b.factsDb.store({
          text: `Overnight research briefing (${dateUtc}): ${title}\n${body}`,
          category: "briefing",
          importance: 0.75,
          entity: `briefing:${slug}`,
          key: "topic",
          value: slug,
          source: "research-executor",
          tags: ["briefing", "research", "unread"],
          provenanceJson: JSON.stringify({
            method: "overnight-research",
            sourceFactIds: [insightId, opts.topicId, ...evidenceFactIds].filter(Boolean),
            urls,
          }),
        } as never);

        // Best-effort embedding — a vectorless briefing still delivers via the session-start block.
        try {
          const vector = await b.embeddings.embed(body);
          await b.vectorDb.store({ text: body, vector, importance: 0.75, category: "briefing", id: briefing.id });
          b.factsDb.setEmbeddingModel(briefing.id, b.embeddings.modelName);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "research-store-embed",
            severity: "info",
          });
        }

        b.factsDb.getRawDb().prepare("UPDATE facts SET value = 'done' WHERE id = ?").run(opts.topicId);
        console.log(JSON.stringify({ status: "stored", briefingId: briefing.id, slug, sources: urls.length }));
      }),
    );

  research
    .command("status")
    .description("Show the research queue, recent briefings, and their evidence chains")
    .option("--json", "Output JSON")
    .option("--days <n>", "Lookback window in days", "14")
    .action(
      withExit(async (opts: { json?: boolean; days?: string }) => {
        const days = Math.max(1, Number.parseInt(opts.days ?? "14", 10) || 14);
        const sinceSec = Math.floor(Date.now() / 1000) - days * 86_400;
        const db = b.factsDb.getRawDb();
        const queue = db
          .prepare(
            `SELECT id, entity, value, text, provenance_json, created_at FROM facts
              WHERE category = 'ops_status' AND entity LIKE 'research:%' AND key = 'status'
                AND superseded_at IS NULL AND created_at >= ?
              ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sinceSec) as unknown as QueueFactRow[];
        const briefings = db
          .prepare(
            `SELECT id, entity, text, tags, created_at FROM facts
              WHERE category = 'briefing' AND superseded_at IS NULL AND created_at >= ?
              ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sinceSec) as Array<{
          id: string;
          entity: string;
          text: string;
          tags: string | null;
          created_at: number;
        }>;

        if (opts.json) {
          const queueOut = queue.map((q) => {
            const insightId = parseSourceFactIds(q.provenance_json)[0] ?? null;
            const { evidence } = hydrateEvidence(b, insightId);
            return {
              id: q.id,
              slug: q.entity.slice("research:".length),
              status: q.value,
              evidenceCount: evidence.length,
              createdAt: q.created_at,
            };
          });
          console.log(
            JSON.stringify({
              queue: queueOut,
              briefings: briefings.map((f) => ({
                id: f.id,
                slug: f.entity?.slice("briefing:".length) ?? null,
                // Exact tag membership, not a substring match — a future tag like
                // "previously-unread" must not be misreported as unread.
                unread: parseTags(f.tags).includes("unread"),
                createdAt: f.created_at,
                title: f.text.split("\n")[0]?.slice(0, 120),
              })),
            }),
          );
          return;
        }
        console.log(`Research queue (last ${days}d): ${queue.length}`);
        for (const q of queue) {
          console.log(
            `  [${q.value}] ${q.entity.slice("research:".length)} (${new Date(q.created_at * 1000).toISOString()}) — ${q.id}`,
          );
        }
        console.log(`Briefings (last ${days}d): ${briefings.length}`);
        for (const f of briefings) {
          const unread = parseTags(f.tags).includes("unread") ? " [unread]" : "";
          console.log(
            `  ${f.entity?.slice("briefing:".length)}${unread} (${new Date(f.created_at * 1000).toISOString()}) — ${f.id}`,
          );
        }
      }),
    );
}
