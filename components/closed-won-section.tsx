"use client"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, Download, Trophy, Loader2 } from "lucide-react"
import { apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type WonDeal = {
  id: string
  name: string
  closeDate: string | null
  amount: number
  ownerName: string
  pipeline: string
}

type Report = {
  dateFrom: string
  dateTo: string
  deals: WonDeal[]
  totalAmount: number
  error?: string
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function toCsvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Closed-won deals whose CLOSE DATE falls within the Funnel page's selected
// date range (passed down as dateFrom/dateTo, plus the optional pipeline filter),
// so this list stays in lock-step with the funnel KPIs above it. Rendered at the
// bottom of the Funnel page.
export function ClosedWonSection({
  configured,
  dateFrom,
  dateTo,
  pipelines,
  periodText,
}: {
  configured: boolean
  dateFrom: string
  dateTo: string
  pipelines: string[]
  periodText: string
}) {
  const report = useQuery({
    queryKey: ["closed-won", dateFrom, dateTo, pipelines.join(",")],
    queryFn: () => apiPost<Report>("/api/hs/closed-won", { dateFrom, dateTo, pipelines }),
    enabled: configured,
  })

  const deals = report.data?.deals ?? []
  const totalAmount = report.data?.totalAmount ?? 0
  const loading = report.isFetching || !report.data

  const repCount = useMemo(() => new Set(deals.map((d) => d.ownerName)).size, [deals])

  function exportCsv() {
    const header = ["Deal", "Closed date", "Amount", "Sales rep", "Pipeline"]
    const body = deals.map((d) => [d.name, fmtDate(d.closeDate), d.amount, d.ownerName, d.pipeline])
    const csv = [header, ...body].map((r) => r.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `closed-won-${dateFrom.slice(0, 10)}_${dateTo.slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }

    // The v0 preview runs inside a sandboxed iframe where a programmatic
    // anchor-download is blocked silently, so open the CSV in a new tab there.
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
            Closed won deals
            {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Deals with a close date during {periodText}
            {loading ? null : (
              <>
                {" "}
                — {formatNumber(deals.length)} deal{deals.length === 1 ? "" : "s"} · {formatCurrency(totalAmount)} ·{" "}
                {formatNumber(repCount)} rep{repCount === 1 ? "" : "s"}
              </>
            )}
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={!report.data || deals.length === 0}>
            <Download className="size-4" />
            Export CSV
          </Button>
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
          <div className="space-y-2">
            <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label="Loading" />
              Loading closed-won deals…
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : deals.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Trophy className="size-4" />
            No closed-won deals in the selected period.
          </p>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Deal</th>
                  <th className="px-2 py-2 text-right font-medium">Closed date</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 text-left font-medium">Sales rep</th>
                  <th className="pl-2 py-2 text-left font-medium">Pipeline</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id} className="border-b border-border/50 transition-colors hover:bg-muted/40">
                    <td className="max-w-[20rem] truncate py-1.5 pr-2" title={d.name}>
                      {d.name}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {fmtDate(d.closeDate)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(d.amount)}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-muted-foreground" title={d.ownerName}>
                      {d.ownerName}
                    </td>
                    <td className="pl-2 py-1.5 text-muted-foreground">{d.pipeline}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 bg-card">
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="py-1.5 pr-2 text-muted-foreground">Total ({formatNumber(deals.length)})</td>
                  <td />
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totalAmount)}</td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
