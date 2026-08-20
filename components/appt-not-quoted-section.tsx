"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, Download, Loader2 } from "lucide-react"
import { apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { resolveRange, RANGE_OPTIONS, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type DealDetail = {
  id: string
  name: string
  ownerName: string
  pipeline: string
  stage: string
  region: string
  subRegion: string
  territory: string
  amount: number
  won: boolean
  quoted: boolean
  apptSet: boolean
  createDate: string | null
  apptDate: string | null
  quotedDate: string | null
  wonDate: string | null
}

type Report = {
  dateFrom: string
  dateTo: string
  deals: DealDetail[]
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Whole days between an ISO date and today (null when missing).
function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000))
}

// Preset name, or a date range string for a custom selection.
function periodLabel(range: RangeKey, custom: CustomRange): string {
  if (range === "custom") {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  return RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
}

// Newest appointment-scheduled date first; deals with no appointment go last.
function byApptDesc(a: DealDetail, b: DealDetail): number {
  const at = a.apptDate ? Date.parse(a.apptDate) : Number.NEGATIVE_INFINITY
  const bt = b.apptDate ? Date.parse(b.apptDate) : Number.NEGATIVE_INFINITY
  return bt - at
}

function toCsvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Detail list of deals that had an appointment scheduled within the selected
// period but never reached a quoted stage (and, by extension, never closed won).
// Has its own date-range selector using the same presets as the Funnel page.
export function ApptNotQuotedSection({ configured }: { configured: boolean }) {
  // Default to a short window so the Funnel page's bottom section paints fast;
  // the sales-rep-report query is heavy over long ranges. Users can widen it.
  const [range, setRange] = useState<RangeKey>("last90")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())

  const resolved = useMemo(() => resolveRange(range, custom), [range, custom])

  const report = useQuery({
    queryKey: ["sales-rep-report", resolved.dateFrom, resolved.dateTo],
    queryFn: () =>
      apiPost<Report>("/api/hs/sales-rep-report", { dateFrom: resolved.dateFrom, dateTo: resolved.dateTo }),
    enabled: configured,
  })

  const deals = report.data?.deals ?? []

  // Appt scheduled in-range but not quoted. Won implies quoted, so this also
  // excludes closed-won deals.
  const rows = useMemo(() => deals.filter((d) => !d.quoted).sort(byApptDesc), [deals])

  const totalAmount = useMemo(() => rows.reduce((s, d) => s + d.amount, 0), [rows])
  const periodText = periodLabel(range, custom)
  const loading = report.isFetching || !report.data

  function exportCsv() {
    const header = [
      "Deal",
      "Sales rep",
      "Pipeline",
      "Stage",
      "Region",
      "Sub-region",
      "Territory",
      "Created",
      "Appt scheduled",
      "Days since appt",
      "Amount",
    ]
    const body = rows.map((d) => [
      d.name,
      d.ownerName,
      d.pipeline,
      d.stage,
      d.region,
      d.subRegion,
      d.territory,
      fmtDate(d.createDate),
      fmtDate(d.apptDate),
      daysSince(d.apptDate) ?? "",
      d.amount,
    ])
    const csv = [header, ...body].map((r) => r.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `appt-not-quoted-${resolved.dateFrom.slice(0, 10)}_${resolved.dateTo.slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }

    // The v0 preview runs inside a sandboxed iframe where a programmatic
    // anchor-download is blocked silently, so open the CSV in a new tab there
    // (the user can save from it). If the popup is blocked, fall back to the
    // direct download. Outside the iframe, download directly.
    if (inIframe) {
      const win = window.open(url, "_blank", "noopener")
      if (!win) download()
    } else {
      download()
    }
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            Appointments scheduled but not quoted
            {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Deals with an appointment scheduled during {periodText} that never reached a quoted stage.
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
          <Button variant="outline" onClick={exportCsv} disabled={!report.data || rows.length === 0}>
            <Download className="size-4" />
            Export CSV
          </Button>
          <Button variant="outline" size="icon" onClick={() => report.refetch()} aria-label="Refresh">
            <RefreshCw className={cn("size-4", report.isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {report.isError ? (
          <div className="flex items-center gap-3 py-4 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {(report.error as Error)?.message || "Failed to load report."}
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label="Loading" />
              Loading appointments…
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No unquoted appointments in the selected period.
          </p>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Deal</th>
                  <th className="px-2 py-2 text-left font-medium">Sales rep</th>
                  <th className="px-2 py-2 text-left font-medium">Pipeline</th>
                  <th className="px-2 py-2 text-left font-medium">Stage</th>
                  <th className="px-2 py-2 text-left font-medium">Region</th>
                  <th className="px-2 py-2 text-left font-medium">Territory</th>
                  <th className="px-2 py-2 text-right font-medium">Created</th>
                  <th className="px-2 py-2 text-right font-medium">Appt scheduled</th>
                  <th className="px-2 py-2 text-right font-medium">Days since appt</th>
                  <th className="pl-2 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const since = daysSince(d.apptDate)
                  return (
                    <tr key={d.id} className="border-b border-border/50 transition-colors hover:bg-muted/40">
                      <td className="max-w-[15rem] truncate py-1.5 pr-2" title={d.name}>
                        {d.name}
                      </td>
                      <td className="max-w-[10rem] truncate px-2 py-1.5 text-muted-foreground" title={d.ownerName}>
                        {d.ownerName}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{d.pipeline}</td>
                      <td className="px-2 py-1.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                          {d.stage}
                        </span>
                      </td>
                      <td className="max-w-[9rem] truncate px-2 py-1.5 text-muted-foreground" title={d.region}>
                        {d.region}
                      </td>
                      <td className="max-w-[9rem] truncate px-2 py-1.5 text-muted-foreground" title={d.territory}>
                        {d.territory}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {fmtDate(d.createDate)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtDate(d.apptDate)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{since === null ? "—" : `${since}d`}</td>
                      <td className="pl-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(d.amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 bg-card">
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="py-1.5 pr-2 text-muted-foreground">Total ({formatNumber(rows.length)})</td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="pl-2 py-1.5 text-right tabular-nums">{formatCurrency(totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
