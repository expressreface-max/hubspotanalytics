"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, Download } from "lucide-react"
import { apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { resolveRange, RANGE_OPTIONS, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type DealMeeting = {
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
  createDate: string | null
  apptDate: string | null
  meetingDate: string | null
  meetingTitle: string | null
  meetingOutcome: string | null
  meetingCount: number
}

type Report = {
  dateFrom: string
  dateTo: string
  deals: DealMeeting[]
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Date + time, for the actual meeting engagement.
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function periodLabel(range: RangeKey, custom: CustomRange): string {
  if (range === "custom") {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  return RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
}

// Newest appointment-scheduled date first; deals with no appointment go last.
function byApptDesc(a: DealMeeting, b: DealMeeting): number {
  const at = a.apptDate ? Date.parse(a.apptDate) : Number.NEGATIVE_INFINITY
  const bt = b.apptDate ? Date.parse(b.apptDate) : Number.NEGATIVE_INFINITY
  return bt - at
}

function toCsvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const OUTCOME_LABEL: Record<string, string> = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  RESCHEDULED: "Rescheduled",
  CANCELED: "Canceled",
  NO_SHOW: "No show",
}

// All deals that had an appointment scheduled within the selected period, with
// the date of the actual HubSpot meeting associated with each deal. Has its own
// date-range selector using the same presets as the Funnel page.
export function ApptScheduledSection({ configured }: { configured: boolean }) {
  // Default to a short window so the Funnel page's bottom section paints fast;
  // the underlying deal search is heavy over long ranges. Users can widen it.
  const [range, setRange] = useState<RangeKey>("last90")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())

  const resolved = useMemo(() => resolveRange(range, custom), [range, custom])

  const report = useQuery({
    queryKey: ["appt-meetings", resolved.dateFrom, resolved.dateTo],
    queryFn: () =>
      apiPost<Report>("/api/hs/appt-meetings", { dateFrom: resolved.dateFrom, dateTo: resolved.dateTo }),
    enabled: configured,
  })

  const rows = useMemo(() => (report.data?.deals ?? []).slice().sort(byApptDesc), [report.data])
  const totalAmount = useMemo(() => rows.reduce((s, d) => s + d.amount, 0), [rows])
  const withMeeting = useMemo(() => rows.filter((d) => d.meetingDate).length, [rows])
  const periodText = periodLabel(range, custom)
  const loading = report.isLoading

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
      "Meeting date",
      "Meeting title",
      "Meeting outcome",
      "Meeting count",
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
      d.meetingDate ? new Date(d.meetingDate).toISOString() : "",
      d.meetingTitle ?? "",
      d.meetingOutcome ? OUTCOME_LABEL[d.meetingOutcome] ?? d.meetingOutcome : "",
      d.meetingCount,
      d.amount,
    ])
    const csv = [header, ...body].map((r) => r.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `appt-scheduled-meetings-${resolved.dateFrom.slice(0, 10)}_${resolved.dateTo.slice(0, 10)}.csv`
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
          <CardTitle className="text-base">Appointments scheduled — with meeting dates</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            All deals with an appointment scheduled during {periodText}, showing the meeting associated with each deal.
            {!loading && rows.length > 0 ? (
              <span className="ml-1">
                {formatNumber(withMeeting)} of {formatNumber(rows.length)} have a linked meeting.
              </span>
            ) : null}
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
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No appointments scheduled in the selected period.
          </p>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[1120px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Deal</th>
                  <th className="px-2 py-2 text-left font-medium">Sales rep</th>
                  <th className="px-2 py-2 text-left font-medium">Pipeline</th>
                  <th className="px-2 py-2 text-left font-medium">Stage</th>
                  <th className="px-2 py-2 text-left font-medium">Territory</th>
                  <th className="px-2 py-2 text-right font-medium">Appt scheduled</th>
                  <th className="px-2 py-2 text-right font-medium">Meeting date</th>
                  <th className="px-2 py-2 text-left font-medium">Outcome</th>
                  <th className="pl-2 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
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
                    <td className="max-w-[9rem] truncate px-2 py-1.5 text-muted-foreground" title={d.territory}>
                      {d.territory}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {fmtDate(d.apptDate)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums" title={d.meetingTitle ?? undefined}>
                      {fmtDateTime(d.meetingDate)}
                      {d.meetingCount > 1 ? (
                        <span className="ml-1 text-xs text-muted-foreground">+{d.meetingCount - 1}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      {d.meetingOutcome ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                          {OUTCOME_LABEL[d.meetingOutcome] ?? d.meetingOutcome}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="pl-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 bg-card">
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="py-1.5 pr-2 text-muted-foreground">Total ({formatNumber(rows.length)})</td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{formatNumber(withMeeting)} w/ meeting</td>
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
