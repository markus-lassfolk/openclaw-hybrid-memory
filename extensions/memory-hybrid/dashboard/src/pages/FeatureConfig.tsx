import { useQuery } from "@tanstack/react-query";
import { fetchConfig } from "@/lib/api";
import { ChartSkeleton } from "@/components/Skeletons";
import { CheckCircle2, XCircle } from "lucide-react";

export default function FeatureConfig() {
  const { data, isLoading } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Feature Configuration</h1>
        <p className="text-sm text-muted-foreground mt-1">Current feature toggles for the hybrid memory system. Read-only.</p>
      </div>

      {isLoading ? (
        <ChartSkeleton />
      ) : data ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.features.map((f) => (
            <div key={f.name} className="rounded-lg border border-border bg-card p-4 flex gap-3">
              <div className="shrink-0 mt-0.5">
                {f.enabled ? (
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <XCircle className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground">{f.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{f.description}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
