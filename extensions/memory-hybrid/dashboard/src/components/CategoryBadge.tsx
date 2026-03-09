import { cn } from "@/lib/utils";

interface CategoryBadgeProps {
  category: string;
  className?: string;
}

const categoryClasses: Record<string, string> = {
  technical: "bg-cat-technical/15 text-cat-technical",
  fact: "bg-cat-fact/15 text-cat-fact",
  project: "bg-cat-project/15 text-cat-project",
  rule: "bg-cat-rule/15 text-cat-rule",
  preference: "bg-cat-preference/15 text-cat-preference",
  decision: "bg-cat-decision/15 text-cat-decision",
  entity: "bg-cat-entity/15 text-cat-entity",
  place: "bg-cat-place/15 text-cat-place",
  pattern: "bg-cat-pattern/15 text-cat-pattern",
  person: "bg-cat-person/15 text-cat-person",
  monitoring: "bg-cat-monitoring/15 text-cat-monitoring",
  other: "bg-cat-other/15 text-cat-other",
};

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        categoryClasses[category] || categoryClasses.other,
        className
      )}
    >
      {category}
    </span>
  );
}
