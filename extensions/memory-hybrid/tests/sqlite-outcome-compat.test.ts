/**
 * Legacy SQLite CHECK constraints on `episodes` and `audit_log` (schema drift
 * from `CREATE TABLE IF NOT EXISTS` vs evolving app enums).
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AuditStore } from "../backends/audit-store.js";
import { recordEpisode, rowToEpisode, searchEpisodes } from "../backends/facts-db/episodes.js";
import {
  _resetEpisodesOutcomeCompatCacheForTests,
  episodeOutcomeForSqliteInsert,
  episodesTableIsLegacyFailedOutcomeCheck,
  storedEpisodeOutcomeToPublic,
} from "../utils/sqlite-outcome-compat.js";

/** Minimal legacy `episodes` DDL (CHECK uses `failed`, not `failure` / `unknown`). */
function createLegacyEpisodesSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failed')),
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      context TEXT,
      related_fact_ids TEXT,
      procedure_id TEXT,
      scope_target TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      decay_class TEXT NOT NULL DEFAULT 'normal',
      scope TEXT NOT NULL DEFAULT 'global',
      agent_id TEXT,
      user_id TEXT,
      session_id TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      verified_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE episode_relations (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL
    )
  `);
}

describe("sqlite-outcome-compat — episodes", () => {
  it("detects legacy CHECK (failed without failure)", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyEpisodesSchema(db);
    expect(episodesTableIsLegacyFailedOutcomeCheck(db)).toBe(true);
    expect(episodeOutcomeForSqliteInsert(db, "failure")).toBe("failed");
    expect(episodeOutcomeForSqliteInsert(db, "unknown")).toBe("failed");
    expect(episodeOutcomeForSqliteInsert(db, "success")).toBe("success");
  });

  it("recordEpisode maps failure/unknown to failed on legacy CHECK", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyEpisodesSchema(db);
    const ep = recordEpisode(db, { event: "tool_error", outcome: "failure" });
    expect(ep.outcome).toBe("failure");
    const row = db.prepare("SELECT outcome FROM episodes WHERE id = ?").get(ep.id) as { outcome: string };
    expect(row.outcome).toBe("failed");
    const full = db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep.id) as Record<string, unknown>;
    expect(rowToEpisode(full).outcome).toBe("failure");
  });

  it("recordEpisode preserves unknown in return on legacy CHECK (stored as failed)", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyEpisodesSchema(db);
    const ep = recordEpisode(db, { event: "ambiguous", outcome: "unknown" });
    expect(ep.outcome).toBe("unknown");
    const row = db.prepare("SELECT outcome FROM episodes WHERE id = ?").get(ep.id) as { outcome: string };
    expect(row.outcome).toBe("failed");
  });

  it("searchEpisodes unknown filter does not include legacy failed rows (avoids mixing with failure)", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyEpisodesSchema(db);
    recordEpisode(db, { event: "fail", outcome: "failure" });
    recordEpisode(db, { event: "unk", outcome: "unknown" });
    expect(searchEpisodes(db, { outcome: ["unknown"], limit: 20 })).toHaveLength(0);
    const failures = searchEpisodes(db, { outcome: ["failure"], limit: 20 });
    expect(failures).toHaveLength(2);
    expect(failures.every((e) => e.outcome === "failure")).toBe(true);
  });

  it("current-style CHECK stores failure verbatim", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial', 'unknown')),
        timestamp INTEGER NOT NULL,
        duration INTEGER,
        context TEXT,
        related_fact_ids TEXT,
        procedure_id TEXT,
        scope_target TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        decay_class TEXT NOT NULL DEFAULT 'normal',
        scope TEXT NOT NULL DEFAULT 'global',
        agent_id TEXT,
        user_id TEXT,
        session_id TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE episode_relations (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL
      )
    `);
    expect(episodesTableIsLegacyFailedOutcomeCheck(db)).toBe(false);
    const ep = recordEpisode(db, { event: "x", outcome: "failure" });
    const row = db.prepare("SELECT outcome FROM episodes WHERE id = ?").get(ep.id) as { outcome: string };
    expect(row.outcome).toBe("failure");
  });

  it("storedEpisodeOutcomeToPublic maps failed → failure", () => {
    expect(storedEpisodeOutcomeToPublic("failed")).toBe("failure");
    expect(storedEpisodeOutcomeToPublic("success")).toBe("success");
  });

  it("cache resets when table is recreated (test hook)", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyEpisodesSchema(db);
    expect(episodesTableIsLegacyFailedOutcomeCheck(db)).toBe(true);
    db.exec("DROP TABLE episode_relations");
    db.exec("DROP TABLE episodes");
    _resetEpisodesOutcomeCompatCacheForTests(db);
    db.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial', 'unknown')),
        timestamp INTEGER NOT NULL,
        duration INTEGER,
        context TEXT,
        related_fact_ids TEXT,
        procedure_id TEXT,
        scope_target TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        decay_class TEXT NOT NULL DEFAULT 'normal',
        scope TEXT NOT NULL DEFAULT 'global',
        agent_id TEXT,
        user_id TEXT,
        session_id TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE episode_relations (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL
      )
    `);
    expect(episodesTableIsLegacyFailedOutcomeCheck(db)).toBe(false);
  });
});

describe("sqlite-outcome-compat — audit_log", () => {
  let dir: string;
  let dbPath: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append maps skipped → failed when legacy CHECK omits skipped", () => {
    dir = join(tmpdir(), `audit-legacy-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "audit.db");

    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failed')),
        duration_ms INTEGER,
        error TEXT,
        context TEXT,
        session_id TEXT,
        model TEXT,
        tokens INTEGER
      )
    `);
    setup.close();

    const store = new AuditStore(dbPath);
    store.append({
      agentId: "a1",
      action: "noop",
      outcome: "skipped",
    });

    const row = (store as unknown as { liveDb: DatabaseSync }).liveDb
      .prepare("SELECT outcome FROM audit_log ORDER BY timestamp DESC LIMIT 1")
      .get() as { outcome: string };
    expect(row.outcome).toBe("failed");
  });

  it("append keeps skipped when CHECK includes skipped (new installs)", () => {
    dir = join(tmpdir(), `audit-new-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "audit2.db");
    const store = new AuditStore(dbPath);
    store.append({
      agentId: "a1",
      action: "noop",
      outcome: "skipped",
    });
    const row = (store as unknown as { liveDb: DatabaseSync }).liveDb
      .prepare("SELECT outcome FROM audit_log ORDER BY timestamp DESC LIMIT 1")
      .get() as { outcome: string };
    expect(row.outcome).toBe("skipped");
  });
});
