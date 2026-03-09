import { useQuery } from "@tanstack/react-query";
import { fetchStats, fetchFacts } from "@/lib/api";
import { getCategoryColor, formatRelativeTime, formatAbsoluteTime } from "@/lib/category-utils";
import { CategoryBadge } from "@/components/CategoryBadge";
import { MetricCardSkeleton, ChartSkeleton, TableSkeleton } from "@/components/Skeletons";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import { Database, Layers, Link2, AlertTriangle, DollarSign } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function MetricCard({ label, value, sub, icon }: { label: string; value: string | number; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <span className="text-2xl font-bold text-foreground">{typeof value === "number" ? value.toLocaleString() : value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

const TIER_COLORS = ["#f59e0b", "#6b7280"];
const DECAY_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const { data: factsData, isLoading: factsLoading } = useQuery({ queryKey: ["recentFacts"], queryFn: () => fetchFacts({ limit: 10 }) });

  return (
    <div className="space-y-6 max-w-7xl">
      <h1 className="text-xl font-bold text-foreground">Dashboard Overview</h1>

      {/* Metric Cards */}
      {statsLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => <MetricCardSkeleton key={i} />)}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <MetricCard label="Total Facts" value={stats.totalFacts} sub="active" icon={<Database className="h-4 w-4" />} />
          <MetricCard label="Categories" value={stats.categories} icon={<Layers className="h-4 w-4" />} />
          <MetricCard label="Links" value={stats.links} sub="relationships" icon={<Link2 className="h-4 w-4" />} />
          <MetricCard label="Open Issues" value={stats.openIssues} icon={<AlertTriangle className="h-4 w-4" />} />
          <MetricCard label="Cost (Month)" value={`$${stats.costThisMonth.toFixed(2)}`} icon={<DollarSign className="h-4 w-4" />} />
        </div>
      ) : null}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Facts by Category */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-4">Facts by Category</h2>
          {statsLoading ? <ChartSkeleton /> : stats ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stats.byCategory} layout="vertical" margin={{ left: 70, right: 20 }}>
                <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} />
                <YAxis type="category" dataKey="category" tick={{ fill: "#9ca3af", fontSize: 11 }} width={65} />
                <RTooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8, color: "#f3f4f6" }} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {stats.byCategory.map((entry) => (
                    <Cell key={entry.category} fill={getCategoryColor(entry.category)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : null}
        </div>

        {/* Tier & Decay */}
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Facts by Tier</h2>
            {statsLoading ? <ChartSkeleton /> : stats ? (
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={stats.byTier} dataKey="count" nameKey="tier" cx="50%" cy="50%" innerRadius={30} outerRadius={55} paddingAngle={3}>
                    {stats.byTier.map((_, i) => <Cell key={i} fill={TIER_COLORS[i]} />)}
                  </Pie>
                  <RTooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8, color: "#f3f4f6" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : null}
            {stats && (
              <div className="flex justify-center gap-4 mt-2">
                {stats.byTier.map((t, i) => (
                  <span key={t.tier} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLORS[i] }} />
                    {t.tier} ({t.count.toLocaleString()})
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Facts by Decay Class</h2>
            {statsLoading ? <ChartSkeleton /> : stats ? (
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={stats.byDecayClass} dataKey="count" nameKey="decay_class" cx="50%" cy="50%" innerRadius={30} outerRadius={55} paddingAngle={3}>
                    {stats.byDecayClass.map((_, i) => <Cell key={i} fill={DECAY_COLORS[i]} />)}
                  </Pie>
                  <RTooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8, color: "#f3f4f6" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : null}
            {stats && (
              <div className="flex flex-wrap justify-center gap-3 mt-2">
                {stats.byDecayClass.map((d, i) => (
                  <span key={d.decay_class} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: DECAY_COLORS[i] }} />
                    {d.decay_class} ({d.count.toLocaleString()})
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Facts */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-muted-foreground mb-4">Recent Facts</h2>
        {factsLoading ? <TableSkeleton /> : factsData ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-2 text-xs text-muted-foreground font-medium">Fact</th>
                  <th className="pb-2 text-xs text-muted-foreground font-medium w-24">Category</th>
                  <th className="pb-2 text-xs text-muted-foreground font-medium w-20">Importance</th>
                  <th className="pb-2 text-xs text-muted-foreground font-medium w-20">Created</th>
                </tr>
              </thead>
              <tbody>
                {factsData.facts.map((fact) => (
                  <tr key={fact.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 max-w-md truncate text-foreground">{fact.text}</td>
                    <td className="py-2.5"><CategoryBadge category={fact.category} /></td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${fact.importance * 100}%`,
                              backgroundColor: fact.importance > 0.8 ? "#f59e0b" : fact.importance > 0.5 ? "#3b82f6" : "#6b7280",
                            }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">{fact.importance.toFixed(2)}</span>
                      </div>
                    </td>
                    <td className="py-2.5">
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
      </div>
    </div>
  );
}
