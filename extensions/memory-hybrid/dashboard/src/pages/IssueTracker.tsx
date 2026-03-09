import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchIssues } from "@/lib/api";
import { formatRelativeTime, formatAbsoluteTime } from "@/lib/category-utils";
import { StatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { TableSkeleton } from "@/components/Skeletons";
import { EmptyState } from "@/components/EmptyState";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

export default function IssueTracker() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["issues", statusFilter, severityFilter],
    queryFn: () =>
      fetchIssues({
        status: statusFilter === "all" ? undefined : statusFilter,
        severity: severityFilter === "all" ? undefined : severityFilter,
      }),
  });

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-xl font-bold text-foreground">Issue Tracker</h1>

      <div className="flex gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 bg-card border-border">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {["open", "diagnosed", "fix-attempted", "resolved", "verified", "wont-fix"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-36 bg-card border-border">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severity</SelectItem>
            {["critical", "high", "medium", "low"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <TableSkeleton rows={4} />
      ) : data && data.issues.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="h-12 w-12" />}
          title="No issues tracked yet"
          description="Issues are created when problems are detected during agent operation. Your agent is running smoothly!"
        />
      ) : data ? (
        <div className="space-y-2">
          {data.issues.map((issue) => (
            <div key={issue.id} className="rounded-lg border border-border bg-card overflow-hidden">
              <button
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                onClick={() => toggle(issue.id)}
              >
                {expanded.has(issue.id) ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="flex-1 text-sm text-foreground font-medium">{issue.title}</span>
                <StatusBadge status={issue.status} />
                <SeverityBadge status={issue.severity} />
                <Tooltip>
                  <TooltipTrigger>
                    <span className="text-xs text-muted-foreground">{formatRelativeTime(issue.detected_at)}</span>
                  </TooltipTrigger>
                  <TooltipContent>{formatAbsoluteTime(issue.detected_at)}</TooltipContent>
                </Tooltip>
              </button>
              {expanded.has(issue.id) && (
                <div className="px-4 pb-4 pt-0 ml-7 space-y-3 text-sm border-t border-border/50">
                  <div className="pt-3">
                    <h4 className="text-xs text-muted-foreground font-medium mb-1">Symptoms</h4>
                    <ul className="list-disc list-inside space-y-0.5">
                      {issue.symptoms.map((s, i) => (
                        <li key={i} className="text-foreground text-xs">{s}</li>
                      ))}
                    </ul>
                  </div>
                  {issue.root_cause && (
                    <div>
                      <h4 className="text-xs text-muted-foreground font-medium mb-1">Root Cause</h4>
                      <p className="text-xs text-foreground">{issue.root_cause}</p>
                    </div>
                  )}
                  {issue.fix && (
                    <div>
                      <h4 className="text-xs text-muted-foreground font-medium mb-1">Fix</h4>
                      <p className="text-xs text-foreground">{issue.fix}</p>
                    </div>
                  )}
                  <div className="flex gap-1 flex-wrap">
                    {issue.tags.map((t) => (
                      <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
