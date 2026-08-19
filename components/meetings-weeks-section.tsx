"use client"

import { Loader2 } from "lucide-react"
import { formatNumber } from "@/lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type WeekKey = "lastWeek" | "thisWeek" | "nextWeek" | "future"
type WeekBucket = { total: number; byType: Record<string, number> }
type RepRow = { rep: string; total: number; weeks: Record<WeekKey, WeekBucket> }
export type MeetingsResponse = {
  configured: boolean
  error?: string
  weeks: { key: WeekKey; label: string; from: string; to: string }[]
  types: string[]
  byRep: RepRow[]
  weekTotals: Record<WeekKey, WeekBucket>
  grandTotal: number
}

const WEEK_ORDER: WeekKey[] = ["lastWeek", "thisWeek", "nextWeek", "future"]

function weekRangeLabel(from: string, to: string): string {
  const f = new Date(from)
  const t = new Date(to)
  const opt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  return `${f.toLocaleDateString(undefined, opt)} – ${t.toLocaleDateString(undefined, opt)}`
}

// A single cell: total meetings (bold) with a per-type breakdown beneath.
function MeetingCell({ bucket, types }: { bucket: WeekBucket; types: string[] }) {
  if (!bucket || bucket.total === 0) {
    return <span className="text-muted-foreground">–</span>
  }
  const present = types.filter((t) => (bucket.byType[t] || 0) > 0)
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-semibold tabular-nums">{formatNumber(bucket.total)}</span>
      {present.map((t) => (
        <span key={t} className="text-xs text-muted-foreground tabular-nums">
          {t} {bucket.byType[t]}
        </span>
      ))}
    </div>
  )
}

export function MeetingsWeeksSection({
  data,
  loading,
}: {
  data: MeetingsResponse | null
  loading: boolean
}) {
  const weeks = data?.weeks ?? WEEK_ORDER.map((key) => ({ key, label: "", from: "", to: "" }))
  const types = data?.types ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meetings</CardTitle>
        <CardDescription>
          Meetings scheduled by sales rep across last, current, and next week (by meeting date), broken out by
          meeting type.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data?.error ? (
          <p className="text-sm text-destructive">{data.error}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 bg-card px-4 py-3 text-left font-medium text-muted-foreground">
                    Sales rep
                  </th>
                  {weeks.map((w) => (
                    <th key={w.key} className="px-4 py-3 text-right font-semibold">
                      {loading ? (
                        <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" aria-label="Loading" />
                      ) : (
                        <div className="flex flex-col items-end">
                          <span>{w.label}</span>
                          <span className="text-xs font-normal text-muted-foreground">
                            {w.key === "future" ? "Beyond next week" : weekRangeLabel(w.from, w.to)}
                          </span>
                        </div>
                      )}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="sticky left-0 z-10 bg-card px-4 py-3 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" aria-label="Loading" />
                      </td>
                      {WEEK_ORDER.map((k) => (
                        <td key={k} className="px-4 py-3 text-right">
                          <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Loading" />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right">
                        <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Loading" />
                      </td>
                    </tr>
                  ))
                ) : data && data.byRep.length > 0 ? (
                  data.byRep.map((row) => (
                    <tr key={row.rep} className="border-b last:border-0 align-top">
                      <td className="sticky left-0 z-10 bg-card px-4 py-3 font-medium">{row.rep}</td>
                      {WEEK_ORDER.map((k) => (
                        <td key={k} className="px-4 py-3 text-right">
                          <MeetingCell bucket={row.weeks[k]} types={types} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatNumber(row.total)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No meetings scheduled in this window.
                    </td>
                  </tr>
                )}
              </tbody>
              {!loading && data && data.byRep.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 align-top font-semibold">
                    <td className="sticky left-0 z-10 bg-card px-4 py-3">Total</td>
                    {WEEK_ORDER.map((k) => (
                      <td key={k} className="px-4 py-3 text-right">
                        <MeetingCell bucket={data.weekTotals[k]} types={types} />
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(data.grandTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
