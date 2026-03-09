import { useQuery } from "@tanstack/react-query";
import { fetchClusters } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { ChartSkeleton } from "@/components/Skeletons";
import { Boxes } from "lucide-react";

export default function KnowledgeClusters() {
  const { data, isLoading } = useQuery({ queryKey: ["clusters"], queryFn: fetchClusters });

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-xl font-bold text-foreground">Knowledge Clusters</h1>

      {isLoading ? (
        <ChartSkeleton />
      ) : data && data.clusters.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-16 w-16" />}
          title="No clusters discovered yet"
          description="Your agent hasn't identified topic clusters in its memory yet. As more facts accumulate and relationships form, clusters will emerge — revealing how knowledge naturally groups together."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.clusters.map((c: any) => (
            <div key={c.id} className="rounded-lg border border-border bg-card p-4">
              <h3 className="font-medium text-foreground">{c.label}</h3>
              <p className="text-xs text-muted-foreground mt-1">{c.fact_count} facts</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
