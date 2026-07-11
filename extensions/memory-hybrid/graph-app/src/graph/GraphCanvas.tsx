/**
 * The constellation. Renders the memory graph on canvas (react-force-graph-2d) with a radial
 * strength layout — the strongest memories are pulled to the center, weaker ones drift outward —
 * plus category coloring, pin/contradiction rings, and live recall pulses.
 */
import { forceRadial } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphNode } from "../api/types";
import { addLink } from "../live/curation";
import { selectVisibleNodes, useGraphStore } from "../store/graphStore";
import { categoryColor, COLORS, linkColor } from "../theme";
import { clusterColor } from "./clustering";

type FGNode = GraphNode & { x?: number; y?: number };
type FGLink = { source: string; target: string; linkType: string; weight: number };

function decayOpacity(decayClass: string | undefined): number {
  const dc = (decayClass ?? "").toLowerCase();
  if (dc.includes("ephemeral") || dc.includes("short")) return 0.5;
  if (dc.includes("volatile")) return 0.7;
  return 0.95;
}

/** Node radius (graph units) from its strength within the current view. */
function nodeRadius(strengthNorm: number): number {
  return 2.5 + strengthNorm * 7;
}

export function GraphCanvas() {
  const fgRef = useRef<ForceGraphMethods<FGNode, FGLink> | undefined>(undefined);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const filters = useGraphStore((s) => s.filters);
  const selectedId = useGraphStore((s) => s.selectedId);
  const pulses = useGraphStore((s) => s.pulses);
  const colorByCluster = useGraphStore((s) => s.colorByCluster);
  const linkingFrom = useGraphStore((s) => s.linkingFrom);
  const setSelected = useGraphStore((s) => s.setSelected);
  const setLinkingFrom = useGraphStore((s) => s.setLinkingFrom);
  const prunePulses = useGraphStore((s) => s.prunePulses);

  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const visibleNodes = useMemo(() => selectVisibleNodes(useGraphStore.getState()), [nodes, filters]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const maxStrength = useMemo(
    () => visibleNodes.reduce((m, n) => Math.max(m, n.strength ?? 0), 0.0001),
    [visibleNodes],
  );

  const graphData = useMemo(() => {
    const links: FGLink[] = edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, linkType: e.linkType, weight: e.weight }));
    return { nodes: visibleNodes as FGNode[], links };
  }, [visibleNodes, edges, visibleIds]);

  // Radial strength layout: target radius grows as strength falls, so the strongest facts converge
  // on the center. Radius scale grows with node count so dense graphs don't collapse into a blob.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const outer = 40 + Math.sqrt(Math.max(visibleNodes.length, 1)) * 26;
    const radiusFor = (node: FGNode) => {
      const norm = Math.min(1, (node.strength ?? 0) / maxStrength);
      return (1 - norm) * outer;
    };
    fg.d3Force("radial", forceRadial<FGNode>(radiusFor, 0, 0).strength(0.55));
    const charge = fg.d3Force("charge") as unknown as { strength?: (s: number) => unknown } | undefined;
    charge?.strength?.(-45);
    fg.d3ReheatSimulation();
  }, [visibleNodes.length, maxStrength]);

  // While recall pulses are active, keep the canvas repainting so the rings animate/fade. Once the
  // simulation has cooled react-force-graph pauses its render loop; resumeAnimation() restarts it
  // (at ~zero alpha the nodes don't move — only the pulse rings redraw). When the last pulse expires
  // we prune it and pause again to return to idle.
  useEffect(() => {
    if (pulses.size === 0) return;
    fgRef.current?.resumeAnimation();
    let raf = 0;
    const tick = () => {
      prunePulses();
      if (useGraphStore.getState().pulses.size > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        fgRef.current?.pauseAnimation();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pulses.size, prunePulses]);

  const nodeFill = (node: FGNode): string =>
    colorByCluster ? clusterColor(node.clusterId) : categoryColor(node.category);

  const paintNode = (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const norm = Math.min(1, (node.strength ?? 0) / maxStrength);
    const r = nodeRadius(norm);
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    // Recall pulse — an expanding, fading ring around a just-recalled node.
    const pulseExp = pulses.get(node.id);
    if (pulseExp) {
      const remaining = Math.max(0, pulseExp - performance.now());
      const t = 1 - Math.min(1, remaining / 2600);
      ctx.beginPath();
      ctx.arc(x, y, r + t * 16, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.8})`;
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    ctx.globalAlpha = decayOpacity(node.decayClass);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = nodeFill(node);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (node.pinned) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = COLORS.pin;
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }
    if (node.contradicted) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = COLORS.contradiction;
      ctx.lineWidth = 1 / globalScale;
      ctx.stroke();
    }
    if (node.id === selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Labels only for strong nodes, and only when zoomed in enough to be legible.
    if (globalScale > 1.5 && norm > 0.55) {
      const label = node.label.length > 28 ? `${node.label.slice(0, 28)}…` : node.label;
      ctx.font = `${11 / globalScale}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(226,232,240,0.85)";
      ctx.textAlign = "center";
      ctx.fillText(label, x, y - r - 4 / globalScale);
    }
  };

  const paintPointerArea = (node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
    const norm = Math.min(1, (node.strength ?? 0) / maxStrength);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(norm) + 3, 0, 2 * Math.PI);
    ctx.fill();
  };

  return (
    <ForceGraph2D<FGNode, FGLink>
      ref={fgRef}
      width={size.width}
      height={size.height}
      graphData={graphData}
      backgroundColor={COLORS.bg}
      nodeId="id"
      nodeRelSize={4}
      nodeCanvasObject={paintNode}
      nodePointerAreaPaint={paintPointerArea}
      linkColor={(l) => linkColor((l as FGLink).linkType)}
      linkWidth={(l) => 0.4 + (l as FGLink).weight * 1.4}
      linkDirectionalParticles={0}
      cooldownTicks={120}
      d3VelocityDecay={0.3}
      onNodeClick={(node) => {
        const id = (node as FGNode).id;
        if (linkingFrom && linkingFrom !== id) {
          // Complete a click-to-bond: create a RELATED_TO link from the pending source.
          void addLink(linkingFrom, id, "RELATED_TO", 0.7);
          setLinkingFrom(null);
        } else {
          setSelected(id);
        }
      }}
      onBackgroundClick={() => {
        if (linkingFrom) setLinkingFrom(null);
        else setSelected(null);
      }}
    />
  );
}
