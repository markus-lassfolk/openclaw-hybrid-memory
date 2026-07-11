import { beforeEach, describe, expect, it } from "vitest";
import { factToNode } from "./api/subscriptions";
import { estimateStrength } from "./api/strength";
import type { GraphEdge, GraphNode } from "./api/types";
import { detectClusters, labelCommunities } from "./graph/clustering";
import { edgeId, selectVisibleNodes, useGraphStore } from "./store/graphStore";
import { decayLevel } from "./theme";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: `node ${id}`,
    category: "fact",
    importance: 0.5,
    confidence: 0.8,
    decayClass: "durable",
    strength: 0.5,
    ...over,
  };
}

const resetStore = () =>
  useGraphStore.setState({
    nodes: [],
    edges: [],
    nodeIndex: new Map(),
    edgeIndex: new Map(),
    stats: null,
    selectedId: null,
    pulses: new Map(),
    activity: [],
    clusters: new Map(),
    filters: { categories: new Set(), minStrength: 0, showSuperseded: false, search: "" },
  });

describe("estimateStrength", () => {
  it("increases with importance", () => {
    const low = estimateStrength({ importance: 0.1, confidence: 0.8 });
    const high = estimateStrength({ importance: 0.9, confidence: 0.8 });
    expect(high).toBeGreaterThan(low);
  });
  it("adds a pin boost", () => {
    const base = estimateStrength({ importance: 0.5, confidence: 0.8, pinned: false });
    const pinned = estimateStrength({ importance: 0.5, confidence: 0.8, pinned: true });
    expect(pinned).toBeGreaterThan(base + 0.25);
  });
});

describe("factToNode", () => {
  it("maps a subscription Fact to a GraphNode with computed strength + superseded flag", () => {
    const n = factToNode({
      id: "f1",
      text: "x".repeat(80),
      category: "decision",
      importance: 0.9,
      confidence: 0.9,
      decayClass: "permanent",
      pinned: true,
      supersededBy: "f2",
      recallCount: 3,
    });
    expect(n.id).toBe("f1");
    expect(n.label.endsWith("…")).toBe(true);
    expect(n.category).toBe("decision");
    expect(n.pinned).toBe(true);
    expect(n.superseded).toBe(true);
    expect(n.strength).toBeGreaterThan(0);
  });
});

describe("detectClusters (Louvain, lazy-loaded)", () => {
  it("separates two disconnected triangles into two communities", async () => {
    const nodes = ["a", "b", "c", "x", "y", "z"].map((id) => node(id));
    const edges: GraphEdge[] = [
      { source: "a", target: "b", linkType: "RELATED_TO", weight: 1 },
      { source: "b", target: "c", linkType: "RELATED_TO", weight: 1 },
      { source: "c", target: "a", linkType: "RELATED_TO", weight: 1 },
      { source: "x", target: "y", linkType: "RELATED_TO", weight: 1 },
      { source: "y", target: "z", linkType: "RELATED_TO", weight: 1 },
      { source: "z", target: "x", linkType: "RELATED_TO", weight: 1 },
    ];
    const clusters = await detectClusters(nodes, edges);
    expect(clusters.get("a")).toBe(clusters.get("b"));
    expect(clusters.get("a")).toBe(clusters.get("c"));
    expect(clusters.get("x")).toBe(clusters.get("y"));
    expect(clusters.get("a")).not.toBe(clusters.get("x"));
  });
});

describe("labelCommunities", () => {
  const communities = new Map([
    ["a", "1"],
    ["b", "1"],
    ["c", "1"],
    ["x", "2"],
    ["y", "2"],
  ]);

  it("prefers server topic-cluster labels by member plurality", () => {
    const labels = labelCommunities(
      ["a", "b", "c", "x", "y"].map((id) => node(id)),
      communities,
      [{ id: "sc1", label: "kubernetes ops", factCount: 3, factIds: ["a", "b", "c"] }],
    );
    expect(labels.get("1")).toBe("kubernetes ops");
    expect(labels.has("2")).toBe(false); // no server cluster and no dominant term
  });

  it("falls back to a dominant entity when the server has no matching cluster", () => {
    const labels = labelCommunities(
      [
        node("a", { entity: "postgres" }),
        node("b", { entity: "postgres" }),
        node("c", { entity: "redis" }),
        node("x"),
        node("y"),
      ],
      communities,
      [],
    );
    expect(labels.get("1")).toBe("postgres");
  });
});

describe("decayLevel", () => {
  const DAY_MS = 86_400_000;
  const now = 1_750_000_000_000;

  it("pinned facts never fade", () => {
    expect(decayLevel({ pinned: true, decayClass: "session", lastAccessedAt: now - 400 * DAY_MS }, now)).toBe(0);
  });

  it("proximity to expiresAt dominates", () => {
    const soon = decayLevel({ decayClass: "durable", expiresAt: (now + 1 * DAY_MS) / 1000 }, now);
    const far = decayLevel({ decayClass: "durable", expiresAt: (now + 29 * DAY_MS) / 1000 }, now);
    expect(soon).toBeGreaterThan(0.9);
    expect(far).toBeLessThan(0.1);
    expect(decayLevel({ decayClass: "durable", expiresAt: (now - DAY_MS) / 1000 }, now)).toBe(1);
  });

  it("staleness scales with time since access against the class horizon", () => {
    const freshDurable = decayLevel({ decayClass: "durable", lastAccessedAt: now - 2 * DAY_MS }, now);
    const staleDurable = decayLevel({ decayClass: "durable", lastAccessedAt: now - 120 * DAY_MS }, now);
    const staleSession = decayLevel({ decayClass: "session", lastAccessedAt: now - 8 * DAY_MS }, now);
    expect(freshDurable).toBeLessThan(0.1);
    expect(staleDurable).toBe(1);
    expect(staleSession).toBe(1); // 7-day horizon for session-class memories
  });
});

describe("graphStore live deltas", () => {
  beforeEach(resetStore);

  it("upsertNode adds a new node and mutates an existing one in place (identity preserved)", () => {
    const store = useGraphStore.getState();
    store.setGraph([node("a", { strength: 0.3 })], [], null);
    const before = useGraphStore.getState().nodeIndex.get("a");
    store.upsertNode(node("a", { strength: 0.9, label: "updated" }));
    const after = useGraphStore.getState().nodeIndex.get("a");
    expect(after).toBe(before); // same object reference → force-graph keeps its position
    expect(after?.strength).toBe(0.9);
    expect(after?.label).toBe("updated");

    store.upsertNode(node("b"));
    expect(
      useGraphStore
        .getState()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("removeNode drops the node, its incident edges, and clears selection", () => {
    const store = useGraphStore.getState();
    store.setGraph(
      [node("a"), node("b"), node("c")],
      [
        { source: "a", target: "b", linkType: "RELATED_TO", weight: 1 },
        { source: "b", target: "c", linkType: "RELATED_TO", weight: 1 },
      ],
      null,
    );
    store.setSelected("b");
    store.removeNode("b");
    const s = useGraphStore.getState();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(s.edges).toHaveLength(0); // both edges touched b
    expect(s.selectedId).toBeNull();
  });

  it("upsertEdge only renders when both endpoints exist; updates in place by id", () => {
    const store = useGraphStore.getState();
    store.setGraph([node("a"), node("b")], [], null);
    store.upsertEdge({ id: "L1", source: "a", target: "z", linkType: "RELATED_TO", weight: 0.5 }); // z missing
    expect(useGraphStore.getState().edges).toHaveLength(0);
    store.upsertEdge({ id: "L1", source: "a", target: "b", linkType: "RELATED_TO", weight: 0.5 });
    expect(useGraphStore.getState().edges).toHaveLength(1);
    // Same id → updates weight in place (no duplicate).
    store.upsertEdge({ id: "L1", source: "a", target: "b", linkType: "RELATED_TO", weight: 0.9 });
    // A link-type change on the same id also updates in place, NOT a second edge.
    store.upsertEdge({ id: "L1", source: "a", target: "b", linkType: "CAUSED_BY", weight: 0.9 });
    const edges = useGraphStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
    expect(edges[0].linkType).toBe("CAUSED_BY");
    expect(edgeId(edges[0])).toBe("L1");
  });

  it("removeEdgeById removes a graph-loaded edge (carries a real id)", () => {
    const store = useGraphStore.getState();
    store.setGraph(
      [node("a"), node("b")],
      [{ id: "L9", source: "a", target: "b", linkType: "RELATED_TO", weight: 0.5 }],
      null,
    );
    expect(useGraphStore.getState().edges).toHaveLength(1);
    store.removeEdgeById("L9");
    expect(useGraphStore.getState().edges).toHaveLength(0);
  });

  it("pulse then prune expires rings", () => {
    const store = useGraphStore.getState();
    store.pulse(["a", "b"], 0); // ttl 0 → already expired
    expect(useGraphStore.getState().pulses.size).toBe(2);
    store.prunePulses();
    expect(useGraphStore.getState().pulses.size).toBe(0);
  });

  it("mergeGraph(prune:true) reconciles a resync snapshot without losing node identity", () => {
    const store = useGraphStore.getState();
    store.setGraph(
      [node("keep", { strength: 0.3 }), node("gone")],
      [{ id: "L1", source: "keep", target: "gone", linkType: "RELATED_TO", weight: 1 }],
      null,
    );
    store.setSelected("gone");
    const keepBefore = useGraphStore.getState().nodeIndex.get("keep");

    store.mergeGraph(
      [node("keep", { strength: 0.9 }), node("new")],
      [{ id: "L2", source: "keep", target: "new", linkType: "RELATED_TO", weight: 1 }],
      { prune: true },
    );

    const s = useGraphStore.getState();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["keep", "new"]);
    // Same object reference → the force sim keeps "keep" exactly where it was.
    expect(s.nodeIndex.get("keep")).toBe(keepBefore);
    expect(s.nodeIndex.get("keep")?.strength).toBe(0.9);
    expect(s.edges.map((e) => e.id)).toEqual(["L2"]); // snapshot's edge set is authoritative
    expect(s.selectedId).toBeNull(); // selection pointed at a pruned node
  });

  it("mergeGraph(prune:false) only ever adds (neighborhood expansion)", () => {
    const store = useGraphStore.getState();
    store.setGraph(
      [node("a"), node("b")],
      [{ id: "L1", source: "a", target: "b", linkType: "RELATED_TO", weight: 1 }],
      null,
    );
    store.mergeGraph(
      [node("b"), node("c")],
      [{ id: "L2", source: "b", target: "c", linkType: "RELATED_TO", weight: 1 }],
      { prune: false },
    );
    const s = useGraphStore.getState();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(s.edges.map((e) => e.id).sort()).toEqual(["L1", "L2"]);
  });

  it("seedActivity appends history below live items, newest-first order preserved", () => {
    const store = useGraphStore.getState();
    store.addActivity("store", "live item");
    store.seedActivity([
      { kind: "recall", label: "recent recall", at: 2000 },
      { kind: "recall", label: "older recall", at: 1000 },
    ]);
    const labels = useGraphStore.getState().activity.map((a) => a.label);
    expect(labels).toEqual(["live item", "recent recall", "older recall"]);
  });
});

describe("selectVisibleNodes", () => {
  beforeEach(resetStore);

  it("filters by category, minStrength, superseded, and search", () => {
    useGraphStore
      .getState()
      .setGraph(
        [
          node("a", { category: "fact", strength: 0.8, label: "alpha memory" }),
          node("b", { category: "decision", strength: 0.2, label: "beta" }),
          node("c", { category: "fact", strength: 0.9, superseded: true, label: "gamma" }),
        ],
        [],
        null,
      );
    useGraphStore.getState().setFilters({ minStrength: 0.5 });
    expect(selectVisibleNodes(useGraphStore.getState()).map((n) => n.id)).toEqual(["a"]);

    useGraphStore.getState().setFilters({ minStrength: 0, categories: new Set(["decision"]) });
    expect(selectVisibleNodes(useGraphStore.getState()).map((n) => n.id)).toEqual(["b"]);

    useGraphStore.getState().setFilters({ categories: new Set(), showSuperseded: true, search: "gamma" });
    expect(selectVisibleNodes(useGraphStore.getState()).map((n) => n.id)).toEqual(["c"]);
  });
});
