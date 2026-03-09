import { useQuery } from "@tanstack/react-query";
import { fetchWorkflows } from "@/lib/api";
import { formatRelativeTime, formatAbsoluteTime } from "@/lib/category-utils";
import { TableSkeleton } from "@/components/Skeletons";
import { EmptyState } from "@/components/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Workflow } from "lucide-react";

const outcomeClasses: Record<string, string> = {
  success: "bg-success/15 text-success",
  failure: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

export default function WorkflowPatterns() {
  const { data, isLoading } = useQuery({ queryKey: ["workflows"], queryFn: fetchWorkflows });

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-xl font-bold text-foreground">Workflow Patterns</h1>

      {isLoading ? (
        <TableSkeleton rows={6} />
      ) : data && data.patterns.length === 0 ? (
        <EmptyState
          icon={<Workflow className="h-16 w-16" />}
          title="No workflow patterns recorded"
          description="As your agent completes tasks, successful tool sequences will be recorded here — helping it learn which approaches work best."
        />
      ) : data ? (
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="p-3 text-xs text-muted-foreground font-medium">Goal</th>
                <th className="p-3 text-xs text-muted-foreground font-medium">Tool Sequence</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Outcome</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Duration</th>
                <th className="p-3 text-xs text-muted-foreground font-medium w-20">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.patterns.map((p, i) => (
                <tr key={i} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="p-3 text-foreground">{p.goal}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-1 flex-wrap">
                      {p.tool_sequence.map((tool: string, j: number) => (
                        <span key={j} className="flex items-center gap-1">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-foreground font-mono">{tool}</span>
                          {j < p.tool_sequence.length - 1 && <span className="text-muted-foreground text-xs">→</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded capitalize ${outcomeClasses[p.outcome] || outcomeClasses.unknown}`}>
                      {p.outcome}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground font-mono">
                    {p.duration_ms >= 60000 ? `${(p.duration_ms / 60000).toFixed(1)}m` : `${(p.duration_ms / 1000).toFixed(0)}s`}
                  </td>
                  <td className="p-3">
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="text-xs text-muted-foreground">{formatRelativeTime(p.created_at)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatAbsoluteTime(p.created_at)}</TooltipContent>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
