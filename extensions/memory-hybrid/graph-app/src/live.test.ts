import { beforeEach, describe, expect, it } from "vitest";
import { factToNode } from "./api/subscriptions";
import { estimateStrength } from "./api/strength";
import type { GraphEdge, GraphNode } from "./api/types";
import { detectClusters } from "./graph/clustering";
import { edgeKey, selectVisibleNodes, useGraphStore } from "./store/graphStore";

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

describe("detectClusters (Louvain)", () => {
  it("separates two disconnected triangles into two communities", () => {
    const nodes = ["a", "b", "c", "x", "y", "z"].map((id) => node(id));
    const edges: GraphEdge[] = [
      { source: "a", target: "b", linkType: "RELATED_TO", weight: 1 },
      { source: "b", target: "c", linkType: "RELATED_TO", weight: 1 },
      { source: "c", target: "a", linkType: "RELATED_TO", weight: 1 },
      { source: "x", target: "y", linkType: "RELATED_TO", weight: 1 },
      { source: "y", target: "z", linkType: "RELATED_TO", weight: 1 },
      { source: "z", target: "x", linkType: "RELATED_TO", weight: 1 },
    ];
    const clusters = detectClusters(nodes, edges);
    expect(clusters.get("a")).toBe(clusters.get("b"));
    expect(clusters.get("a")).toBe(clusters.get("c"));
    expect(clusters.get("x")).toBe(clusters.get("y"));
    expect(clusters.get("a")).not.toBe(clusters.get("x"));
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
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
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

  it("upsertEdge only renders when both endpoints exist; updates weight otherwise", () => {
    const store = useGraphStore.getState();
    store.setGraph([node("a"), node("b")], [], null);
    store.upsertEdge({ source: "a", target: "z", linkType: "RELATED_TO", weight: 0.5 }); // z missing
    expect(useGraphStore.getState().edges).toHaveLength(0);
    store.upsertEdge({ source: "a", target: "b", linkType: "RELATED_TO", weight: 0.5 });
    expect(useGraphStore.getState().edges).toHaveLength(1);
    store.upsertEdge({ source: "a", target: "b", linkType: "RELATED_TO", weight: 0.9 });
    const edges = useGraphStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
    expect(edgeKey(edges[0])).toBe("a|b|RELATED_TO");
  });

  it("pulse then prune expires rings", () => {
    const store = useGraphStore.getState();
    store.pulse(["a", "b"], 0); // ttl 0 → already expired
    expect(useGraphStore.getState().pulses.size).toBe(2);
    store.prunePulses();
    expect(useGraphStore.getState().pulses.size).toBe(0);
  });
});

describe("selectVisibleNodes", () => {
  beforeEach(resetStore);

  it("filters by category, minStrength, superseded, and search", () => {
    useGraphStore.getState().setGraph(
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
