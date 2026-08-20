"use client"

import { TrendingUp, CalendarDays, Loader2 } from "lucide-react"
import { formatCurrency, formatNumber } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

type Bucket = {
  key: string
  label: string
  count: number
  amount: number
  conversionPct: number
  forecastAmount: number
}

type MonthForecast = {
  label: string
  won: number
  wonCount: number
  openForecast: number
  total: number
}

export type QuoteAnalysis = {
  aging: { buckets: Bucket[]; totalCount: number; totalAmount: number; totalForecast: number }
  forecast: { thisMonth: MonthForecast; lastMonth: MonthForecast }
  error?: string
}

// Copied from the Quotes page: deals currently in the Quoted stage, aged into
// 30-day bands, with a conversion-driven forecast. On the Sales Manager page it
// renders a pre-computed nightly snapshot (prop-driven, no live query).
export function OpenQuotePipelineSection({
  data,
  loading,
}: {
  data: QuoteAnalysis | null
  loading: boolean
}) {
  const buckets = data?.aging?.buckets ?? []
  const blendedPct =
    data && data.aging.totalAmount > 0 ? (data.aging.totalForecast / data.aging.totalAmount) * 100 : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Open quote pipeline by age
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            deals currently in the Quoted stage, by days since quoted
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data?.error ? (
          <div className="py-2 text-sm text-destructive">{data.error || "Failed to load quote analysis."}</div>
        ) : loading ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label="Loading" />
              Loading pipeline data…
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-40 w-full" />
              ))}
            </div>
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
  )
}
