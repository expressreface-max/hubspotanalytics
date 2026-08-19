"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, CalendarCheck } from "lucide-react"
import { apiPost, formatNumber } from "@/lib/api"
import { resolveRange, RANGE_OPTIONS, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type RepRow = {
  rep: string
  meetings: number
  byType: Record<string, number>
}

type Report = {
  dateFrom: string
  dateTo: string
  totalMeetings: number
  types: string[]
  typeTotals: Record<string, number>
  byRep: RepRow[]
  error?: string
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function periodLabel(range: RangeKey, custom: CustomRange): string {
  if (range === "custom") {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  return RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
}

// Summary of meetings SET within the period, counted by each meeting's actual
// start date (NOT by when a deal entered the appointment stage). Shows a big
// total plus a per-sales-rep breakdown. Rendered at the TOP of the Funnel page.
export function MeetingsSetSection({ configured }: { configured: boolean }) {
  const [range, setRange] = useState<RangeKey>("last90")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())

  const resolved = useMemo(() => resolveRange(range, custom), [range, custom])

  const report = useQuery({
    queryKey: ["meetings-set", resolved.dateFrom, resolved.dateTo],
    queryFn: () =>
      apiPost<Report>("/api/hs/meetings-set", { dateFrom: resolved.dateFrom, dateTo: resolved.dateTo }),
    enabled: configured,
  })

  const totalMeetings = report.data?.totalMeetings ?? 0
  const byRep = report.data?.byRep ?? []
  const types = report.data?.types ?? []
  const typeTotals = report.data?.typeTotals ?? {}

  const periodText = periodLabel(range, custom)
  const loading = report.isLoading

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base">Meetings set</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Meetings with a start date during {periodText}, broken down by type and detailed by the rep who attended.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeSelect
            value={range}
            onValueChange={setRange}
            custom={custom}
            onCustomChange={setCustom}
            triggerClassName="w-[170px]"
          />
          <Button variant="outline" size="icon" onClick={() => report.refetch()} aria-label="Refresh">
            <RefreshCw className={cn("size-4", report.isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {report.isError || report.data?.error ? (
          <div className="flex items-center gap-3 py-4 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {(report.data?.error as string) || (report.error as Error)?.message || "Failed to load report."}
          </div>
        ) : loading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Headline totals */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <CalendarCheck className="size-4 text-primary" />
                  Total meetings
                </div>
                <div className="mt-2 text-3xl font-bold tabular-nums">{formatNumber(totalMeetings)}</div>
                <div className="mt-1 text-xs text-muted-foreground">across {periodText}</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales reps</div>
                <div className="mt-2 text-3xl font-bold tabular-nums">{formatNumber(byRep.length)}</div>
                <div className="mt-1 text-xs text-muted-foreground">with meetings set</div>
              </div>
            </div>

            {/* Meeting-type breakdown */}
            {types.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {types.map((t) => (
                  <div key={t} className="rounded-lg border p-3">
                    <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground" title={t}>
                      {t}
                    </div>
                    <div className="mt-1 text-xl font-bold tabular-nums">{formatNumber(typeTotals[t] ?? 0)}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {totalMeetings > 0 ? `${(((typeTotals[t] ?? 0) / totalMeetings) * 100).toFixed(0)}%` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Per-rep breakdown */}
            {byRep.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No meetings set in the selected period.</p>
            ) : (
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-2 text-left font-medium">Sales rep</th>
                      {types.map((t) => (
                        <th key={t} className="px-2 py-2 text-right font-medium" title={t}>
                          {t}
                        </th>
                      ))}
                      <th className="px-2 py-2 text-right font-medium">Meetings</th>
                      <th className="pl-2 py-2 text-right font-medium">% of total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byRep.map((r) => (
                      <tr key={r.rep} className="border-b border-border/50 transition-colors hover:bg-muted/40">
                        <td className="max-w-[16rem] truncate py-1.5 pr-2" title={r.rep}>
                          {r.rep}
                        </td>
                        {types.map((t) => (
                          <td key={t} className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {r.byType[t] ? formatNumber(r.byType[t]) : "—"}
                          </td>
                        ))}
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatNumber(r.meetings)}</td>
                        <td className="pl-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {totalMeetings > 0 ? `${((r.meetings / totalMeetings) * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="sticky bottom-0 z-10 bg-card">
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="py-1.5 pr-2 text-muted-foreground">Total ({formatNumber(byRep.length)} reps)</td>
                      {types.map((t) => (
                        <td key={t} className="px-2 py-1.5 text-right tabular-nums">
                          {formatNumber(typeTotals[t] ?? 0)}
                        </td>
                      ))}
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(totalMeetings)}</td>
                      <td className="pl-2 py-1.5 text-right tabular-nums">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
