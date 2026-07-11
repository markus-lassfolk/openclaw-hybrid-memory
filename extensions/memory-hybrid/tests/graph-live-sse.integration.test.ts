/**
 * End-to-end real-time path: a live GraphQL subscription over SSE, served by the real dashboard
 * server, must deliver an event when a fact is stored directly on the shared FactsDB (i.e. the
 * normal tool/auto-capture path, NOT a GraphQL mutation). This is the whole point of the Memory
 * Graph overlay, and it exercises: FactsDB.store → memory-events → pubsub bridge → Yoga
 * subscription → the dashboard server's streaming /graphql handler → SSE client.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { _testing } from "../index.js";
import { createDashboardServer } from "../routes/dashboard-server.js";
import { resetMemoryEventsBridgeForTests } from "../routes/memory-events-bridge.js";
import { resetMemoryEventBus } from "../services/memory-events.js";

const { FactsDB, VectorDB } = _testing;
const VECTOR_DIM = 4;

async function detectLoopbackBindSupport(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      probe.close();
      resolve(false);
    });
    probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

const canBind = await detectLoopbackBindSupport();
const maybeIt = canBind ? it : it.skip;

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let server: Awaited<ReturnType<typeof createDashboardServer>> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-sse-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  resetMemoryEventsBridgeForTests();
  resetMemoryEventBus();
});

afterEach(() => {
  server?.close();
  server = null;
  resetMemoryEventsBridgeForTests();
  resetMemoryEventBus();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Open an SSE subscription (graphql-sse distinct-connections mode: POST + Accept: text/event-stream). */
function openSubscription(port: number, query: string, onFrame: (text: string) => void): () => void {
  const body = JSON.stringify({ query });
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/graphql",
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "content-length": Buffer.byteLength(body),
    },
  });
  req.on("response", (res) => {
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => onFrame(chunk));
  });
  req.on("error", () => {});
  req.end(body);
  return () => req.destroy();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

maybeIt(
  "delivers factCreated over SSE when a fact is stored on the shared FactsDB (tool path)",
  async () => {
    const ctx = {
      factsDb,
      vectorDb: new VectorDB(join(tmpDir, "lance"), VECTOR_DIM),
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      resolvedLancePath: join(tmpDir, "lance"),
    };
    server = await createDashboardServer(ctx as never, 0);
    const port = server.port;

    let received = "";
    const close = openSubscription(port, "subscription { factCreated { id text category } }", (f) => {
      received += f;
    });

    // Give the SSE subscription time to register on the pubsub before we publish.
    await delay(400);

    const stored = factsDb.store({
      text: "A live fact stored through the tool path",
      category: "fact",
      source: "conversation",
      entity: null,
      key: null,
      value: null,
      importance: 0.7,
    });

    // Poll until the event arrives (bridge emit is microtask-deferred, then streamed over SSE).
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.includes(stored.id)) {
      await delay(100);
    }
    close();

    expect(received).toContain(stored.id);
    expect(received).toContain("A live fact stored through the tool path");
  },
  15000,
);

maybeIt(
  "delivers recallOccurred over SSE with per-fact scores",
  async () => {
    const { recordRecallEvent } = await import("../services/recall-events.js");
    const ctx = {
      factsDb,
      vectorDb: new VectorDB(join(tmpDir, "lance"), VECTOR_DIM),
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      resolvedLancePath: join(tmpDir, "lance"),
    };
    server = await createDashboardServer(ctx as never, 0);
    const port = server.port;

    const fact = factsDb.store({
      text: "recallable fact",
      category: "fact",
      source: "conversation",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });

    let received = "";
    const close = openSubscription(port, "subscription { recallOccurred { source hits { factId score } } }", (f) => {
      received += f;
    });
    await delay(400);

    recordRecallEvent(factsDb.getRawDb(), {
      query: "test",
      source: "tool",
      factIds: [fact.id],
      hit: true,
      scores: { [fact.id]: 0.88 },
    });

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.includes(fact.id)) {
      await delay(100);
    }
    close();

    expect(received).toContain(fact.id);
    expect(received).toContain("0.88");
  },
  15000,
);
