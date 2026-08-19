"use client"

import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell } from "recharts"
import { Play, Download, Loader2 } from "lucide-react"
import { apiGet, apiPost } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { resolveRange, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"

type Status = { configured: boolean }
type ReportRow = { label: string; value: number }
type ReportResult = {
  groupBy: string
  groupLabel: string
  metric: string
  totalDeals: number
  rows: ReportRow[]
}

const GROUP_OPTIONS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "er_region", label: "Region" },
  { key: "er_sub_region", label: "Sub-region" },
  { key: "er_territory", label: "Territory" },
  { key: "dealstage", label: "Deal stage" },
  { key: "zip", label: "ZIP code" },
]

const METRIC_OPTIONS = [
  { key: "count", label: "Deal count" },
  { key: "revenue", label: "Revenue" },
  { key: "won", label: "Won deals" },
]

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const currency = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)

export function ReportsView() {
  const [groupBy, setGroupBy] = useState("er_territory")
  const [metric, setMetric] = useState("count")
  const [dateField, setDateField] = useState<"createdate" | "closedate">("createdate")
  const [range, setRange] = useState<RangeKey>("ytd")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const run = useMutation({
    mutationFn: () => {
      const { dateFrom, dateTo } = resolveRange(range, custom)
      return apiPost<ReportResult>("/api/hs/report/run", {
        dateField,
        dateFrom,
        dateTo,
        groupBy,
        metric,
      })
    },
  })

  const result = run.data
  const isRevenue = result?.metric === "revenue"

  function formatValue(v: number) {
    return isRevenue ? currency(v) : v.toLocaleString()
  }

  function exportCsv() {
    if (!result) return
    const header = `${result.groupLabel},${result.metric}\n`
    const lines = result.rows.map((r) => `"${r.label}",${r.value}`).join("\n")
    const blob = new Blob([header + lines], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `report-${result.groupBy}-${result.metric}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (status.isLoading) return <Skeleton className="h-64 w-full" />

  if (!connected) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Reports" description="Build custom grouped reports from your CRM." />
        <NotConnected />
      </div>
    )
  }

  const chartData = (result?.rows ?? []).slice(0, 12)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Build ad-hoc reports grouped by territory, pipeline, stage, and more."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Report builder</CardTitle>
          <CardDescription>Choose how to group and measure your deals, then run.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Group by</Label>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v ?? "er_territory")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GROUP_OPTIONS.map((o) => (
                    <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Metric</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v ?? "count")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METRIC_OPTIONS.map((o) => (
                    <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Date field</Label>
              <Select value={dateField} onValueChange={(v) => setDateField((v as typeof dateField) ?? "createdate")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="createdate">Create date</SelectItem>
                  <SelectItem value="closedate">Close date</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Date range</Label>
              <DateRangeSelect
                value={range}
                onValueChange={setRange}
                custom={custom}
                onCustomChange={setCustom}
                triggerClassName="w-full"
              />
            </div>
            <div className="flex items-end">
              <Button onClick={() => run.mutate()} disabled={run.isPending} className="w-full gap-2">
                {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Run report
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {run.isError ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-sm text-destructive">{(run.error as Error).message}</p>
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">
                  {METRIC_OPTIONS.find((m) => m.key === result.metric)?.label} by {result.groupLabel}
                </CardTitle>
                <CardDescription>{result.totalDeals.toLocaleString()} deals analyzed</CardDescription>
              </div>
              <Button variant="outline" size="sm" className="gap-2" onClick={exportCsv}>
                <Download className="size-4" /> Export CSV
              </Button>
            </CardHeader>
            <CardContent>
              {chartData.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No data for this report.</p>
              ) : (
                <ChartContainer
                  config={{ value: { label: result.groupLabel, color: "var(--chart-1)" } }}
                  className="h-[360px] w-full"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                      <XAxis type="number" tickFormatter={(v) => (isRevenue ? `$${(v / 1000).toFixed(0)}k` : String(v))} />
                      <YAxis type="category" dataKey="label" width={140} tick={{ fontSize: 12 }} />
                      <ChartTooltip
                        content={<ChartTooltipContent formatter={(v) => formatValue(Number(v))} />}
                      />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {chartData.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detail</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{result.groupLabel}</TableHead>
                      <TableHead className="text-right">
                        {METRIC_OPTIONS.find((m) => m.key === result.metric)?.label}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((r) => (
                      <TableRow key={r.label}>
                        <TableCell className="font-medium">{r.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatValue(r.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Badge variant="secondary">No report yet</Badge>
            <p className="text-sm text-muted-foreground">
              Configure your options above and click <span className="font-medium">Run report</span>.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
