"use client"

import { Fragment, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, ChevronRight, ChevronDown, Loader2 } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { resolveRange, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Status = { configured: boolean }

type Cell = { contacts: number; appts: number; won: number; revenue: number }
type Agg = { cells: Record<string, Cell>; total: Cell }
type TerrNode = Agg & { name: string }
type SubNode = Agg & { name: string; territories: TerrNode[] }
type RegionNode = Agg & { name: string; subRegions: SubNode[] }
type AttrResponse = {
  source: string
  touch: "first" | "last"
  dateFrom: string
  dateTo: string
  sources: string[]
  sourceLabels: Record<string, string>
  regions: RegionNode[]
  columnTotals: Record<string, Cell>
  grandTotal: Cell
}

type MetricKey = keyof Cell
// `prevKey` marks the funnel stage each metric converts FROM, so we can show
// "% of previous stage" next to Appointments (% of Contacts) and Closed won
// (% of Appointments). Contacts and Revenue have no meaningful "previous"
// stage in this funnel.
const METRICS: { key: MetricKey; label: string; money?: boolean; prevKey?: MetricKey }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "appts", label: "Appointments", prevKey: "contacts" },
  { key: "won", label: "Closed won", prevKey: "appts" },
  { key: "revenue", label: "Revenue", money: true },
]

function pctOf(numerator: number, denominator: number): string | null {
  if (!denominator) return null
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  )
}

export function AttributionView() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("last12")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())
  const [touch, setTouch] = useState<"first" | "last">("first")
  const [metric, setMetric] = useState<MetricKey>("won")
  // Expanded region / sub-region keys (default collapsed: empty = all collapsed).
  // Sub-region keys are "region|||sub".
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const range = useMemo(() => resolveRange(rangeKey, custom), [rangeKey, custom])

  const report = useQuery({
    queryKey: ["attribution", range.dateFrom, range.dateTo, touch],
    queryFn: () =>
      apiPost<AttrResponse>("/api/hs/attribution", {
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        touch,
      }),
    enabled: !!connected,
  })
  const data = report.data

  const isMoney = metric === "revenue"
  const fmt = (n: number) => (isMoney ? formatCurrency(n) : formatNumber(n))
  const cellVal = (c: Cell | undefined) => (c ? c[metric] : 0)

  const metricLabel = METRICS.find((m) => m.key === metric)!.label
  const activeMetricDef = METRICS.find((m) => m.key === metric)!
  const prevMetricLabel = activeMetricDef.prevKey
    ? METRICS.find((m) => m.key === activeMetricDef.prevKey)?.label
    : null

  // Render the per-source metric cells + row total for one aggregation node.
  // When the selected metric converts from a previous funnel stage (Appointments
  // from Contacts, Closed won from Appointments), show that conversion rate as
  // a small sub-line under the value so the percentage is visible everywhere
  // the metric appears, not just in the summary tiles.
  const renderCells = (agg: Agg, dense: boolean) =>
    (data?.sources ?? []).map((s) => {
      const v = cellVal(agg.cells[s])
      const prevV = activeMetricDef.prevKey ? agg.cells[s]?.[activeMetricDef.prevKey] ?? 0 : undefined
      const pct = activeMetricDef.prevKey ? pctOf(v, prevV ?? 0) : null
      return (
        <td
          key={s}
          className={cn(dense ? "px-2 py-1.5" : "px-2 py-2", "text-right tabular-nums", v === 0 ? "text-muted-foreground/40" : "")}
        >
          <div className="flex flex-col items-end">
            <span>{v === 0 ? "–" : fmt(v)}</span>
            {activeMetricDef.prevKey && v > 0 && (
              <span className="text-[11px] font-normal text-muted-foreground">{pct ?? "–"}</span>
            )}
          </div>
        </td>
      )
    })

  // Row-total value with the same "% of previous stage" sub-line as renderCells,
  // used for the rightmost Total column and the footer totals row.
  const totalCellValue = (agg: Agg) => {
    const v = cellVal(agg.total)
    const prevV = activeMetricDef.prevKey ? agg.total[activeMetricDef.prevKey] : undefined
    const pct = activeMetricDef.prevKey ? pctOf(v, prevV ?? 0) : null
    return (
      <div className="flex flex-col items-end">
        <span>{fmt(v)}</span>
        {activeMetricDef.prevKey && v > 0 && (
          <span className="text-[11px] font-normal text-muted-foreground">{pct ?? "–"}</span>
        )}
      </div>
    )
  }

  const exportCsv = () => {
    if (!data) return
    const label = (s: string) => data.sourceLabels[s] || s
    const q = (s: string) => `"${(s || "").replace(/"/g, '""')}"`
    const cellsFor = (a: Agg) => [...data.sources.map((s) => cellVal(a.cells[s])), cellVal(a.total)]
    const header = ["Level", "Region", "Sub-region", "Territory", ...data.sources.map(label), "Total"]
    const lines = [header.join(",")]
    for (const region of data.regions) {
      lines.push(["Region", q(region.name), "", "", ...cellsFor(region)].join(","))
      for (const sub of region.subRegions) {
        lines.push(["Sub-region", q(region.name), q(sub.name), "", ...cellsFor(sub)].join(","))
        for (const terr of sub.territories) {
          lines.push(["Territory", q(region.name), q(sub.name), q(terr.name), ...cellsFor(terr)].join(","))
        }
      }
    }
    lines.push(
      ["Total", "", "", "", ...data.sources.map((s) => cellVal(data.columnTotals[s])), cellVal(data.grandTotal)].join(
        ",",
      ),
    )
    const blob = new Blob([lines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `attribution-${metric}-${touch}-touch.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (status.isSuccess && !connected) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Attribution" description="Contacts, appointments, and revenue by territory and source" />
        <NotConnected />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Attribution"
        description="Marketing source performance by territory · contacts, appointments, closed won, and revenue"
      >
        <DateRangeSelect value={rangeKey} onValueChange={setRangeKey} custom={custom} onCustomChange={setCustom} />
      </PageHeader>

      {/* Controls: attribution touch + metric */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Attribution model</Label>
          <div className="flex items-center gap-2">
            <Pill active={touch === "first"} onClick={() => setTouch("first")}>
              First touch (original)
            </Pill>
            <Pill active={touch === "last"} onClick={() => setTouch("last")}>
              Last touch (latest)
            </Pill>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Metric</Label>
          <div className="flex flex-wrap items-center gap-2">
            {METRICS.map((m) => (
              <Pill key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
                {m.label}
              </Pill>
            ))}
          </div>
        </div>
      </div>

      {/* Summary tiles: grand totals for the range (touch-dependent) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {METRICS.map((m) => {
          const isLoading = report.isFetching || !data
          const value = data?.grandTotal[m.key] ?? 0
          const prevValue = m.prevKey ? data?.grandTotal[m.prevKey] : undefined
          const pct = m.prevKey && data ? pctOf(value, prevValue ?? 0) : null
          return (
            <Card key={m.key}>
              <CardContent className="flex flex-col gap-1 py-4">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.label}</span>
                {isLoading ? (
                  <span className="flex items-center gap-2 py-1">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
                  </span>
                ) : (
                  <>
                    <span className="text-2xl font-semibold tabular-nums">
                      {m.money ? formatCurrency(value) : formatNumber(value)}
                    </span>
                    {m.prevKey && (
                      <span className="text-xs text-muted-foreground">
                        {pct ? `${pct} of ${METRICS.find((x) => x.key === m.prevKey)?.label}` : "—"}
                      </span>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {metricLabel} by region &amp; source · {touch === "first" ? "first" : "last"} touch
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Region → sub-region → territory. Click a region or sub-region to collapse. Columns are HubSpot marketing
              sources.{" "}
              {prevMetricLabel && `Small numbers under each value show % of ${prevMetricLabel.toLowerCase()}.`}
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={!data}>
            <Download className="size-4" />
            CSV
          </Button>
        </CardHeader>
        <CardContent>
          {report.isError ? (
            <div className="py-10 text-center text-sm text-destructive">
              {(report.error as Error)?.message || "Failed to load attribution."}
            </div>
          ) : report.isFetching || !data ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-label="Loading" />
                Loading attribution data… this can take a little while.
              </div>
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : data.regions.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No data for this range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 z-10 min-w-56 bg-card py-2 pr-3 text-left font-medium">
                      Region / Sub-region / Territory
                    </th>
                    {data.sources.map((s) => (
                      <th key={s} className="min-w-24 px-2 py-2 text-right font-medium">
                        {data.sourceLabels[s] || s}
                      </th>
                    ))}
                    <th className="min-w-24 px-2 py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.regions.map((region) => {
                    const rKey = region.name
                    const rCollapsed = !expanded.has(rKey)
                    return (
                      <Fragment key={rKey}>
                        {/* Region row */}
                        <tr
                          className="cursor-pointer border-b bg-muted/60 font-semibold hover:bg-muted"
                          onClick={() => toggle(rKey)}
                        >
                          <td className="sticky left-0 z-10 bg-muted/60 py-2 pr-3">
                            <span className="inline-flex items-center gap-1">
                              {rCollapsed ? (
                                <ChevronRight className="size-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="size-3.5 text-muted-foreground" />
                              )}
                              {region.name}
                            </span>
                          </td>
                          {renderCells(region, false)}
                          <td className="px-2 py-2 text-right tabular-nums">{totalCellValue(region)}</td>
                        </tr>

                        {!rCollapsed &&
                          region.subRegions.map((sub) => {
                            const sKey = `${region.name}|||${sub.name}`
                            const sCollapsed = !expanded.has(sKey)
                            return (
                              <Fragment key={sKey}>
                                {/* Sub-region row */}
                                <tr
                                  className="cursor-pointer border-b border-border/60 bg-muted/20 font-medium hover:bg-muted/40"
                                  onClick={() => toggle(sKey)}
                                >
                                  <td className="sticky left-0 z-10 bg-muted/20 py-1.5 pl-6 pr-3">
                                    <span className="inline-flex items-center gap-1">
                                      {sCollapsed ? (
                                        <ChevronRight className="size-3.5 text-muted-foreground" />
                                      ) : (
                                        <ChevronDown className="size-3.5 text-muted-foreground" />
                                      )}
                                      {sub.name}
                                    </span>
                                  </td>
                                  {renderCells(sub, true)}
                                  <td className="px-2 py-1.5 text-right tabular-nums">{totalCellValue(sub)}</td>
                                </tr>

                                {!sCollapsed &&
                                  sub.territories.map((terr) => (
                                    <tr
                                      key={`${sKey}|||${terr.name}`}
                                      className="border-b border-border/40 hover:bg-accent/40"
                                    >
                                      <td className="sticky left-0 z-10 bg-card py-1.5 pl-10 pr-3">{terr.name}</td>
                                      {renderCells(terr, true)}
                                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                                        {totalCellValue(terr)}
                                      </td>
                                    </tr>
                                  ))}
                              </Fragment>
                            )
                          })}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="sticky left-0 z-10 bg-card py-2 pr-3">Total</td>
                    {data.sources.map((s) => {
                      const c = data.columnTotals[s]
                      const v = cellVal(c)
                      const prevV = activeMetricDef.prevKey ? c?.[activeMetricDef.prevKey] : undefined
                      const pct = activeMetricDef.prevKey ? pctOf(v, prevV ?? 0) : null
                      return (
                        <td key={s} className="px-2 py-2 text-right tabular-nums">
                          <div className="flex flex-col items-end">
                            <span>{fmt(v)}</span>
                            {activeMetricDef.prevKey && v > 0 && (
                              <span className="text-[11px] font-normal text-muted-foreground">{pct ?? "–"}</span>
                            )}
                          </div>
                        </td>
                      )
                    })}
                    <td className="px-2 py-2 text-right tabular-nums">
                      <div className="flex flex-col items-end">
                        <span>{fmt(cellVal(data.grandTotal))}</span>
                        {activeMetricDef.prevKey && cellVal(data.grandTotal) > 0 && (
                          <span className="text-[11px] font-normal text-muted-foreground">
                            {pctOf(cellVal(data.grandTotal), data.grandTotal[activeMetricDef.prevKey] ?? 0) ?? "–"}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
