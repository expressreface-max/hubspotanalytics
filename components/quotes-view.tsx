"use client"

import { useQuery } from "@tanstack/react-query"
import { TrendingUp, Clock, CalendarDays, Loader2 } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Bucket = {
  key: string
  label: string
  count: number
  amount: number
  conversionPct: number
  forecastAmount: number
}

type ModelBand = {
  key: string
  label: string
  threshold: number
  eligible: number
  won: number
  conversionPct: number
}

type TimelineBand = {
  start: number
  end: number
  label: string
  atRisk: number
  wonInBand: number
  lostInBand: number
  condWinPct: number
  condLossPct: number
  cumWonPct: number
  cumLostPct: number
  stillOpenPct: number
}

type OpenRow = {
  id: string
  name: string
  quotedDate: string | null
  ageDays: number | null
  band: string
  amount: number
  pipeline: string
}

type QuoteAnalysis = {
  asOf: string
  aging: { buckets: Bucket[]; totalCount: number; totalAmount: number; totalForecast: number }
  model: {
    windowMonths: number
    cohortSize: number
    wonTotal: number
    overallRatePct: number
    medianDaysToWon: number
    bands: ModelBand[]
  }
  forecast: {
    thisMonth: MonthForecast
    lastMonth: MonthForecast
  }
  timeline: TimelineBand[]
  openDetail: OpenRow[]
  error?: string
}

type MonthForecast = {
  label: string
  won: number
  wonCount: number
  openForecast: number
  total: number
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Trigger a client-side CSV download that also works inside the v0 preview iframe.
function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  if (window.self !== window.top) {
    window.open(url, "_blank")
  } else {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function QuotesView() {
  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })
  const configured = !!status.data?.configured

  const report = useQuery({
    queryKey: ["quote-analysis"],
    queryFn: () => apiPost<QuoteAnalysis>("/api/hs/quote-analysis", {}),
    enabled: configured,
  })

  if (!status.isLoading && !configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Quotes" description="Quote aging and conversion forecast." />
        <NotConnected />
      </div>
    )
  }

  const data = report.data
  const buckets = data?.aging.buckets ?? []
  const model = data?.model
  const timeline = data?.timeline ?? []
  const openDetail = data?.openDetail ?? []
  const loading = report.isLoading

  // Trim trailing all-quiet bands (no at-risk quotes left) so the table stops
  // where the data does, but always keep at least the first 12 months.
  const lastActive = timeline.reduce((idx, b, i) => (b.atRisk > 0 ? i : idx), 0)
  const timelineRows = timeline.slice(0, Math.max(11, lastActive) + 1)
  const firstBand = timeline[0]
  const secondBand = timeline[1]
  const thirdBand = timeline[2]

  const blendedPct =
    data && data.aging.totalAmount > 0 ? (data.aging.totalForecast / data.aging.totalAmount) * 100 : 0

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
          title="Quotes"
          description="Express Reface pipeline only. Open quote pipeline aged into 30-day bands, with a forecast driven by how quotes have converted over the last 24 months."
        />

      {report.error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {(report.error as Error).message || "Failed to load quote analysis."}
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Section 1: Open quote pipeline by age ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Open quote pipeline by age
            <span className="text-sm font-normal text-muted-foreground">
              deals currently in the Quoted stage, by days since quoted
            </span>
            {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="col-span-full flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-label="Loading" />
                Loading quote pipeline…
              </div>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-40 w-full" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {buckets.map((b) => (
                  <div key={b.key} className="rounded-lg border p-4">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{b.label}</div>
                    <div className="mt-2 num text-2xl font-bold">{formatCurrency(b.amount)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatNumber(b.count)} open quotes</div>
                    <div className="mt-3 flex items-baseline justify-between border-t pt-3">
                      <div>
                        <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">Forecast</div>
                        <div className="num text-lg font-semibold text-chart-3">{formatCurrency(b.forecastAmount)}</div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        {b.conversionPct.toFixed(1)}%<br />win rate
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Totals strip */}
              <div className="grid grid-cols-1 gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Total open quote value
                  </div>
                  <div className="mt-1 num text-2xl font-bold">{formatCurrency(data?.aging.totalAmount ?? 0)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatNumber(data?.aging.totalCount ?? 0)} open quotes
                  </div>
                </div>
                <div className="sm:border-l sm:pl-4">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <TrendingUp className="size-3.5" /> Forecasted to close
                  </div>
                  <div className="mt-1 num text-2xl font-bold text-chart-3">
                    {formatCurrency(data?.aging.totalForecast ?? 0)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">expected won revenue from open quotes</div>
                </div>
                <div className="sm:border-l sm:pl-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Blended win rate
                  </div>
                  <div className="mt-1 num text-2xl font-bold">{blendedPct.toFixed(1)}%</div>
                  <div className="mt-1 text-xs text-muted-foreground">forecast ÷ open value</div>
                </div>
              </div>

              {/* Monthly sales forecast: closed-won actuals + expected close from open pipeline */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <CalendarDays className="size-3.5" /> Sales forecast by month
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {/* This month */}
                  <div className="rounded-lg border p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold">{data?.forecast.thisMonth.label ?? "This month"}</span>
                      <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">in progress</span>
                    </div>
                    <div className="mt-2 num text-2xl font-bold text-chart-3">
                      {formatCurrency(data?.forecast.thisMonth.total ?? 0)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">forecasted total</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-sm">
                      <div>
                        <div className="num font-semibold">{formatCurrency(data?.forecast.thisMonth.won ?? 0)}</div>
                        <div className="text-xs text-muted-foreground">
                          closed won · {formatNumber(data?.forecast.thisMonth.wonCount ?? 0)} deals
                        </div>
                      </div>
                      <div>
                        <div className="num font-semibold">
                          {formatCurrency(data?.forecast.thisMonth.openForecast ?? 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">expected from open pipeline</div>
                      </div>
                    </div>
                  </div>

                  {/* Last month */}
                  <div className="rounded-lg border p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold">{data?.forecast.lastMonth.label ?? "Last month"}</span>
                      <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">final</span>
                    </div>
                    <div className="mt-2 num text-2xl font-bold">
                      {formatCurrency(data?.forecast.lastMonth.total ?? 0)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">closed won revenue</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-sm">
                      <div>
                        <div className="num font-semibold">{formatCurrency(data?.forecast.lastMonth.won ?? 0)}</div>
                        <div className="text-xs text-muted-foreground">
                          closed won · {formatNumber(data?.forecast.lastMonth.wonCount ?? 0)} deals
                        </div>
                      </div>
                      <div>
                        <div className="num font-semibold text-muted-foreground">—</div>
                        <div className="text-xs text-muted-foreground">month complete</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Section 2: Conversion model ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Quote conversion model
            <span className="text-sm font-normal text-muted-foreground">last 24 months</span>
            {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Quotes analyzed
                  </div>
                  <div className="mt-1 num text-2xl font-bold">{formatNumber(model?.cohortSize ?? 0)}</div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Eventually won
                  </div>
                  <div className="mt-1 num text-2xl font-bold">{formatNumber(model?.wonTotal ?? 0)}</div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Win rate</div>
                  <div className="mt-1 num text-2xl font-bold text-chart-3">
                    {(model?.overallRatePct ?? 0).toFixed(1)}%
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Clock className="size-3.5" /> Median days to win
                  </div>
                  <div className="mt-1 num text-2xl font-bold">{formatNumber(model?.medianDaysToWon ?? 0)}</div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-2 text-left font-medium">Age band</th>
                      <th className="px-2 py-2 text-left font-medium">Still open at</th>
                      <th className="px-2 py-2 text-right font-medium">Quotes reaching</th>
                      <th className="px-2 py-2 text-right font-medium">Eventually won</th>
                      <th className="pl-2 py-2 text-right font-medium">Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(model?.bands ?? []).map((b) => (
                      <tr key={b.key} className="border-b border-border/50">
                        <td className="py-2 pr-2 font-medium">{b.label}</td>
                        <td className="px-2 py-2 text-muted-foreground">day {b.threshold}+</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatNumber(b.eligible)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatNumber(b.won)}</td>
                        <td className="pl-2 py-2 text-right font-semibold tabular-nums text-chart-3">
                          {b.conversionPct.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                Each band&apos;s win rate is the share of quotes that were still open at that age and eventually closed
                won. The forecast in section one multiplies each open band&apos;s value by its band win rate — so a quote
                that has sat open past 90 days is weighted by how often such stale quotes still close.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Section 3: Quote outcome timeline ---- */}
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Quote outcome timeline
              <span className="text-sm font-normal text-muted-foreground">
                30-day bands, last 24 months
              </span>
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              For a brand-new quote: how likely it is to win in each 30-day window, and where every quote ends up over
              time. Conditional rates account for censoring (still-open quotes leave the at-risk pool once we can no
              longer observe them).
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!timeline.length}
            onClick={() =>
              downloadCsv("quote-outcome-timeline.csv", [
                [
                  "Band",
                  "Open at band start",
                  "Won in band",
                  "Lost in band",
                  "Cond. win %",
                  "Cond. loss %",
                  "Cumulative won %",
                  "Cumulative lost %",
                  "Still open %",
                ],
                ...timeline.map((b) => [
                  b.label,
                  b.atRisk,
                  b.wonInBand,
                  b.lostInBand,
                  b.condWinPct.toFixed(1),
                  b.condLossPct.toFixed(1),
                  b.cumWonPct.toFixed(1),
                  b.cumLostPct.toFixed(1),
                  b.stillOpenPct.toFixed(1),
                ]),
              ])
            }
          >
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Conditional chain headline */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Win within 30 days
                  </div>
                  <div className="mt-1 num text-2xl font-bold text-chart-3">
                    {(firstBand?.condWinPct ?? 0).toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">of all new quotes</div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    If still open at 30d → win by 60d
                  </div>
                  <div className="mt-1 num text-2xl font-bold text-chart-3">
                    {(secondBand?.condWinPct ?? 0).toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{(secondBand?.condLossPct ?? 0).toFixed(1)}% lost in this window</div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    If still open at 60d → win by 90d
                  </div>
                  <div className="mt-1 num text-2xl font-bold text-chart-3">
                    {(thirdBand?.condWinPct ?? 0).toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{(thirdBand?.condLossPct ?? 0).toFixed(1)}% lost in this window</div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-2 text-left font-medium">Band</th>
                      <th className="px-2 py-2 text-right font-medium">Open at start</th>
                      <th className="px-2 py-2 text-right font-medium">Won</th>
                      <th className="px-2 py-2 text-right font-medium">Lost</th>
                      <th className="px-2 py-2 text-right font-medium">Cond. win %</th>
                      <th className="px-2 py-2 text-right font-medium">Cond. loss %</th>
                      <th className="px-2 py-2 text-left font-medium">Outcome by end of band</th>
                      <th className="pl-2 py-2 text-right font-medium">Cum. won %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timelineRows.map((b) => (
                      <tr key={b.label} className="border-b border-border/50">
                        <td className="py-2 pr-2 font-medium">{b.label}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatNumber(b.atRisk)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-chart-3">{formatNumber(b.wonInBand)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-destructive">
                          {formatNumber(b.lostInBand)}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums text-chart-3">
                          {b.condWinPct.toFixed(1)}%
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {b.condLossPct.toFixed(1)}%
                        </td>
                        <td className="px-2 py-2">
                          <div
                            className="flex h-2.5 w-full min-w-[140px] overflow-hidden rounded-full bg-muted"
                            title={`Won ${b.cumWonPct.toFixed(0)}% · Lost ${b.cumLostPct.toFixed(0)}% · Open ${b.stillOpenPct.toFixed(0)}%`}
                          >
                            <div className="h-full bg-chart-3" style={{ width: `${b.cumWonPct}%` }} />
                            <div className="h-full bg-destructive" style={{ width: `${b.cumLostPct}%` }} />
                          </div>
                        </td>
                        <td className="pl-2 py-2 text-right font-semibold tabular-nums">{b.cumWonPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-chart-3" /> Won
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-destructive" /> Lost
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-muted" /> Still open
                </span>
                <span className="ml-auto">
                  Cond. win % = share of quotes still open at the band start that win during that 30-day window.
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Detail: open quotes ---- */}
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            Open quotes
            {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={!openDetail.length}
            onClick={() =>
              downloadCsv("open-quotes.csv", [
                ["Deal", "Pipeline", "Quoted date", "Age (days)", "Age band", "Amount"],
                ...openDetail.map((r) => [
                  r.name,
                  r.pipeline,
                  fmtDate(r.quotedDate),
                  r.ageDays ?? "",
                  r.band,
                  r.amount,
                ]),
              ])
            }
          >
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="sticky top-0 z-10 bg-card">
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 text-left font-medium">Deal</th>
                    <th className="px-2 py-2 text-left font-medium">Pipeline</th>
                    <th className="px-2 py-2 text-left font-medium">Quoted</th>
                    <th className="px-2 py-2 text-right font-medium">Age (days)</th>
                    <th className="px-2 py-2 text-left font-medium">Band</th>
                    <th className="pl-2 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {openDetail.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 transition-colors hover:bg-muted/40">
                      <td className="max-w-[18rem] truncate py-1.5 pr-2" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.pipeline}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.quotedDate)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.ageDays ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            r.band === "91+ days" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {r.band}
                        </span>
                      </td>
                      <td className="pl-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 z-10 bg-card">
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="py-1.5 pr-2 text-muted-foreground" colSpan={5}>
                      Total ({formatNumber(openDetail.length)} open quotes)
                    </td>
                    <td className="pl-2 py-1.5 text-right tabular-nums">
                      {formatCurrency(data?.aging.totalAmount ?? 0)}
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
