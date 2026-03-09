import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchCost } from "@/lib/api";
import { MetricCardSkeleton, ChartSkeleton } from "@/components/Skeletons";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, CartesianGrid,
} from "recharts";
import { Button } from "@/components/ui/button";
import { DollarSign, TrendingUp, Cpu, Calendar } from "lucide-react";

const RANGES = ["7d", "30d", "90d"] as const;
const COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#8b5cf6", "#ec4899"];

function MetricCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <span className="text-2xl font-bold text-foreground">{value}</span>
    </div>
  );
}

export default function CostUsage() {
  const [range, setRange] = useState<string>("30d");
  const { data, isLoading } = useQuery({ queryKey: ["cost", range], queryFn: () => fetchCost(range) });

  const tooltipStyle = { backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8, color: "#f3f4f6" };

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-foreground">Cost & Usage</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <Button key={r} variant={range === r ? "default" : "ghost"} size="sm" onClick={() => setRange(r)}>
              {r}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <MetricCardSkeleton key={i} />)}
        </div>
      ) : data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="This Month" value={`$${data.summary.totalMonth.toFixed(2)}`} icon={<DollarSign className="h-4 w-4" />} />
          <MetricCard label="Today" value={`$${data.summary.totalToday.toFixed(2)}`} icon={<Calendar className="h-4 w-4" />} />
          <MetricCard label="Avg / Day" value={`$${data.summary.avgDaily.toFixed(2)}`} icon={<TrendingUp className="h-4 w-4" />} />
          <MetricCard label="Top Model" value={data.summary.topModel.split("-").slice(0, 2).join("-")} icon={<Cpu className="h-4 w-4" />} />
        </div>
      ) : null}

      {/* Daily Cost Chart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-muted-foreground mb-4">Daily Cost</h2>
        {isLoading ? <ChartSkeleton /> : data ? (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={data.daily}>
              <defs>
                <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="date" tick={{ fill: "#9ca3af", fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} tickFormatter={(v) => `$${v}`} />
              <RTooltip contentStyle={tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`, "Cost"]} />
              <Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="url(#costGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Model */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-4">Cost by Model</h2>
          {isLoading ? <ChartSkeleton /> : data ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.byModel}>
                <XAxis dataKey="model" tick={{ fill: "#9ca3af", fontSize: 9 }} tickFormatter={(m) => m.split("-").slice(-2).join("-")} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} tickFormatter={(v) => `$${v}`} />
                <RTooltip contentStyle={tooltipStyle} />
                <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                  {data.byModel.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : null}
        </div>

        {/* Cost by Feature */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-4">Cost by Feature</h2>
          {isLoading ? <ChartSkeleton /> : data ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={data.byFeature} dataKey="cost" nameKey="feature" cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3}>
                    {data.byFeature.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                  </Pie>
                  <RTooltip contentStyle={tooltipStyle} formatter={(v: number) => `$${v.toFixed(2)}`} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap justify-center gap-3 mt-2">
                {data.byFeature.map((f, i) => (
                  <span key={f.feature} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                    {f.feature}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Token Usage */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-muted-foreground mb-4">Token Usage</h2>
        {isLoading ? <ChartSkeleton /> : data ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="date" tick={{ fill: "#9ca3af", fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <RTooltip contentStyle={tooltipStyle} />
              <Area type="monotone" dataKey="tokens_in" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={1.5} name="Input" />
              <Area type="monotone" dataKey="tokens_out" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={1.5} name="Output" />
            </AreaChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </div>
  );
}
