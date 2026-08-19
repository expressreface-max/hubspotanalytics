"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import { DollarSign, Trophy, Calculator, Layers, RefreshCw } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { KpiCard } from "@/components/kpi-card"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function DashboardView() {
  const [pipeline, setPipeline] = useState<string>("all")

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })

  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiGet<{ pipelines: { id: string; label: string }[] }>("/api/hs/pipelines"),
    enabled: !!status.data?.configured,
  })

  const summary = useQuery({
    queryKey: ["analytics-summary", pipeline],
    queryFn: () =>
      apiPost("/api/hs/analytics/summary", {
        pipelines: pipeline === "all" ? [] : [pipeline],
      }),
    enabled: !!status.data?.configured,
  })

  if (status.isLoading) {
    return <DashboardSkeleton />
  }

  if (!status.data?.configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Dashboard" description="Revenue and job performance across all territories." />
        <NotConnected />
      </div>
    )
  }

  const data = summary.data
  const currency = data?.currentYear ?? new Date().getFullYear()
  const prior = data?.priorYear ?? currency - 1

  const revenueConfig: ChartConfig = {
    current: { label: String(currency), color: "var(--chart-1)" },
    prior: { label: String(prior), color: "var(--chart-2)" },
  }
  const jobsConfig: ChartConfig = {
    current: { label: String(currency), color: "var(--chart-1)" },
    prior: { label: String(prior), color: "var(--chart-2)" },
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Revenue and job performance across all territories.">
        <Select value={pipeline} onValueChange={(v) => setPipeline(v ?? "all")}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All pipelines" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All pipelines</SelectItem>
            {pipelines.data?.pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={() => summary.refetch()} aria-label="Refresh">
          <RefreshCw className={`size-4 ${summary.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </PageHeader>

      {summary.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="py-6 text-sm text-destructive">
            Failed to load analytics: {(summary.error as Error)?.message}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Revenue (closed won)"
          value={formatCurrency(data?.kpis?.totalRevenue ?? 0)}
          icon={DollarSign}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Jobs won"
          value={formatNumber(data?.kpis?.closedWon ?? 0)}
          icon={Trophy}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Avg deal size"
          value={formatCurrency(data?.kpis?.avgDealSize ?? 0)}
          icon={Calculator}
          loading={summary.isLoading}
        />
        <KpiCard
          label="Active pipelines"
          value={formatNumber(data?.kpis?.activePipelines ?? 0)}
          icon={Layers}
          loading={summary.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue by Month</CardTitle>
            <CardDescription>
              {currency} vs {prior} (closed won)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <ChartContainer config={revenueConfig} className="h-[260px] w-full">
                <BarChart data={data?.revenueByMonth ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="prior" fill="var(--color-prior)" radius={4} />
                  <Bar dataKey="current" fill="var(--color-current)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Jobs by Month</CardTitle>
            <CardDescription>
              {currency} vs {prior} (count of won deals)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <ChartContainer config={jobsConfig} className="h-[260px] w-full">
                <LineChart data={data?.jobsByMonth ?? []}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line
                    dataKey="prior"
                    stroke="var(--color-prior)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    dataKey="current"
                    stroke="var(--color-current)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue by Pipeline</CardTitle>
            <CardDescription>Share of closed won revenue</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <ChartContainer config={{}} className="h-[260px] w-full">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={data?.revenueByPipeline ?? []}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                  >
                    {(data?.revenueByPipeline ?? []).map((_: any, i: number) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue by ZIP</CardTitle>
            <CardDescription>Top ZIP codes by closed won revenue</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <ChartContainer
                config={{ value: { label: "Revenue", color: "var(--chart-1)" } }}
                className="h-[260px] w-full"
              >
                <BarChart data={data?.revenueByZip ?? []} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="zip"
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" fill="var(--color-value)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[320px] w-full" />
        ))}
      </div>
    </div>
  )
}
