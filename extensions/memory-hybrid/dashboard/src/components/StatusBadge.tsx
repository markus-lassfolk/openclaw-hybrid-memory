import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

const statusClasses: Record<string, string> = {
  open: "bg-info/15 text-info",
  diagnosed: "bg-warning/15 text-warning",
  "fix-attempted": "bg-cat-project/15 text-cat-project",
  resolved: "bg-success/15 text-success",
  verified: "bg-cat-entity/15 text-cat-entity",
  "wont-fix": "bg-muted text-muted-foreground",
};

const severityClasses: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-cat-place/15 text-cat-place",
  medium: "bg-warning/15 text-warning",
  low: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize", statusClasses[status] || "bg-muted text-muted-foreground", className)}>
      {status}
    </span>
  );
}

export function SeverityBadge({ status, className }: StatusBadgeProps) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize", severityClasses[status] || "bg-muted text-muted-foreground", className)}>
      {status}
    </span>
  );
}
