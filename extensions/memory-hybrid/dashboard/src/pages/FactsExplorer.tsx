import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchFacts } from "@/lib/api";
import { formatRelativeTime, formatAbsoluteTime } from "@/lib/category-utils";
import { CategoryBadge } from "@/components/CategoryBadge";
import { TableSkeleton } from "@/components/Skeletons";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CATEGORY_COLORS } from "@/lib/mock-data";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function FactsExplorer() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [tier, setTier] = useState("all");
  const [selectedFact, setSelectedFact] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["facts", search, category, tier],
    queryFn: () =>
      fetchFacts({
        search: search || undefined,
        category: category === "all" ? undefined : category,
        tier: tier === "all" ? undefined : tier,
      }),
  });

  return (
    <div className="space-y-4 max-w-7xl">
      <h1 className="text-xl font-bold text-foreground">Facts Explorer</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search facts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 bg-card border-border"
        />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-40 bg-card border-border">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.keys(CATEGORY_COLORS).map((c) => (
              <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger className="w-32 bg-card border-border">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
          </SelectContent>
        </Select>
        {data && (
          <span className="flex items-center text-xs text-muted-foreground ml-auto">
            Showing {data.facts.length} of {data.total.toLocaleString()}
          </span>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={8} />
      ) : data ? (
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="p-3 text-xs text-muted-foreground font-medium">Fact</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-24">Category</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-24">Entity</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Importance</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-16">Tier</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Decay</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-16">Scope</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.facts.map((fact) => (
                <tr
                  key={fact.id}
                  className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => setSelectedFact(fact)}
                >
                  <td className="p-3 max-w-sm truncate text-foreground">{fact.text}</td>
                  <td className="p-3"><CategoryBadge category={fact.category} /></td>
                  <td className="p-3 text-xs text-muted-foreground font-mono">{fact.entity || "—"}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${fact.importance * 100}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground font-mono">{fact.importance.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${fact.tier === "warm" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}`}>
                      {fact.tier}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground capitalize">{fact.decay_class}</td>
                  <td className="p-3 text-xs text-muted-foreground">{fact.scope}</td>
                  <td className="p-3">
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="text-xs text-muted-foreground">{formatRelativeTime(fact.created_at)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatAbsoluteTime(fact.created_at)}</TooltipContent>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Fact Detail Dialog */}
      <Dialog open={!!selectedFact} onOpenChange={() => setSelectedFact(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Fact Detail</DialogTitle>
          </DialogHeader>
          {selectedFact && (
            <div className="space-y-3 text-sm">
              <p className="text-foreground leading-relaxed">{selectedFact.text}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Category:</span> <CategoryBadge category={selectedFact.category} /></div>
                <div><span className="text-muted-foreground">Entity:</span> <span className="text-foreground font-mono">{selectedFact.entity || "—"}</span></div>
                <div><span className="text-muted-foreground">Importance:</span> <span className="text-foreground font-mono">{selectedFact.importance}</span></div>
                <div><span className="text-muted-foreground">Confidence:</span> <span className="text-foreground font-mono">{selectedFact.confidence}</span></div>
                <div><span className="text-muted-foreground">Tier:</span> <span className="text-foreground">{selectedFact.tier}</span></div>
                <div><span className="text-muted-foreground">Decay:</span> <span className="text-foreground">{selectedFact.decay_class}</span></div>
                <div><span className="text-muted-foreground">Scope:</span> <span className="text-foreground">{selectedFact.scope}</span></div>
                <div><span className="text-muted-foreground">Recalls:</span> <span className="text-foreground font-mono">{selectedFact.recall_count}</span></div>
              </div>
              {selectedFact.tags && (
                <div>
                  <span className="text-xs text-muted-foreground">Tags: </span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {selectedFact.tags.split(",").map((t: string) => (
                      <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t.trim()}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                ID: <span className="font-mono text-foreground">{selectedFact.id}</span> · Created {formatAbsoluteTime(selectedFact.created_at)}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
