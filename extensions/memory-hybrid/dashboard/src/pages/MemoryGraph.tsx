import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGraph } from "@/lib/api";
import { getCategoryColor } from "@/lib/category-utils";
import { CATEGORY_COLORS } from "@/lib/mock-data";
import { ChartSkeleton } from "@/components/Skeletons";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import ForceGraph2D from "react-force-graph-2d";

export default function MemoryGraph() {
  const [nodeLimit, setNodeLimit] = useState(80);
  const [search, setSearch] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set(Object.keys(CATEGORY_COLORS)));
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const { data, isLoading } = useQuery({
    queryKey: ["graph", nodeLimit],
    queryFn: () => fetchGraph({ limit: nodeLimit }),
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height: Math.max(height, 500) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const filteredData = data
    ? (() => {
        let nodes = data.nodes.filter((n) => selectedCategories.has(n.category));
        if (search) nodes = nodes.filter((n) => n.text.toLowerCase().includes(search.toLowerCase()) || n.entity?.toLowerCase().includes(search.toLowerCase()));
        const ids = new Set(nodes.map((n) => n.id));
        const edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
        return { nodes, links: edges.map((e) => ({ ...e })) };
      })()
    : { nodes: [], links: [] };

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };

  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D) => {
    const size = 3 + (node.importance || 0.5) * 6;
    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = getCategoryColor(node.category);
    ctx.globalAlpha = node === selectedNode ? 1 : 0.8;
    ctx.fill();
    if (node === selectedNode) {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [selectedNode]);

  return (
    <div className="space-y-4 h-full">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-foreground">Memory Graph</h1>
        <span className="text-xs text-muted-foreground">
          {filteredData.nodes.length} nodes · {filteredData.links.length} edges
        </span>
      </div>

      <div className="flex gap-4 flex-col lg:flex-row">
        {/* Controls */}
        <div className="lg:w-64 space-y-4 shrink-0">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Search</Label>
            <Input
              placeholder="Search nodes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-card border-border"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">
              Node Limit: {nodeLimit}
            </Label>
            <Slider
              value={[nodeLimit]}
              onValueChange={([v]) => setNodeLimit(v)}
              min={10}
              max={100}
              step={10}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Categories</Label>
            <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
              {Object.keys(CATEGORY_COLORS).map((cat) => (
                <label key={cat} className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={selectedCategories.has(cat)}
                    onCheckedChange={() => toggleCategory(cat)}
                  />
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getCategoryColor(cat) }} />
                  <span className="text-foreground capitalize">{cat}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Selected node info */}
          {selectedNode && (
            <div className="rounded-lg border border-border bg-card p-3 space-y-2">
              <h3 className="text-xs font-medium text-primary">Selected Node</h3>
              <p className="text-xs text-foreground leading-relaxed">{selectedNode.text}</p>
              <div className="flex gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Category: <span className="text-foreground capitalize">{selectedNode.category}</span></span>
                {selectedNode.entity && <span className="text-xs text-muted-foreground">Entity: <span className="text-foreground">{selectedNode.entity}</span></span>}
              </div>
              <span className="text-xs text-muted-foreground">Importance: <span className="font-mono text-foreground">{selectedNode.importance?.toFixed(2)}</span></span>
            </div>
          )}
        </div>

        {/* Graph */}
        <div ref={containerRef} className="flex-1 rounded-lg border border-border bg-card overflow-hidden min-h-[500px]">
          {isLoading ? (
            <div className="p-8"><ChartSkeleton /></div>
          ) : (
            <ForceGraph2D
              graphData={filteredData}
              width={dimensions.width}
              height={dimensions.height}
              nodeCanvasObject={nodeCanvasObject}
              nodePointerAreaPaint={(node: any, color, ctx) => {
                const size = 3 + (node.importance || 0.5) * 6;
                ctx.beginPath();
                ctx.arc(node.x, node.y, size + 2, 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
              }}
              linkColor={() => "rgba(255,255,255,0.08)"}
              linkWidth={(link: any) => 0.5 + (link.strength || 0.5) * 1.5}
              onNodeClick={(node: any) => setSelectedNode(node)}
              backgroundColor="transparent"
              cooldownTicks={100}
            />
          )}
        </div>
      </div>
    </div>
  );
}
