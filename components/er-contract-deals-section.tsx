"use client"

import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, Download, FileText } from "lucide-react"
import { apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Row = {
  id: string
  name: string
  closeDate: string | null
  jobTypes: string[]
  cabinet: number
  countertop: number
  amount: number
  contract: number
  delta: number
  cabinetMismatch: boolean
  countertopMismatch: boolean
}

type Totals = {
  cabinet: number
  countertop: number
  amount: number
  contract: number
  delta: number
}

type Report = {
  dateFrom: string
  dateTo: string
  rows: Row[]
  totals: Totals
  mismatchCount: number
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

// Delta of deal amount vs contract amount, colored by sign: a negative delta
// (deal amount below contract) shows in the destructive tone, positive in green.
function DeltaCell({ value }: { value: number }) {
  const zero = Math.round(value) === 0
  return (
    <span
      className={cn(
        "tabular-nums",
        zero ? "text-muted-foreground" : value < 0 ? "text-destructive" : "text-chart-3",
      )}
    >
      {zero ? "—" : `${value > 0 ? "+" : ""}${formatCurrency(value)}`}
    </span>
  )
}

// Closed-won Express Reface deals over the trailing 12 months, comparing the
// cabinet (reface) and countertop product amounts against the deal amount and
// the contracted price, with the deal-vs-contract delta per row. Self-contained
// with a fixed window + pipeline, so it does not follow the funnel page controls.
export function ErContractDealsSection({ configured }: { configured: boolean }) {
  const report = useQuery({
    queryKey: ["er-contract-deals"],
    queryFn: () => apiPost<Report>("/api/hs/er-contract-deals", {}),
    enabled: configured,
  })

  const rows = report.data?.rows ?? []
  const totals = report.data?.totals
  const mismatchCount = report.data?.mismatchCount ?? 0
  const loading = report.isLoading

  function exportCsv() {
    const header = [
      "Deal",
      "Closed date",
      "Job type(s)",
      "Cabinet",
      "Countertop",
      "Deal amount",
      "Contract amount",
      "Delta",
      "Job type mismatch",
    ]
    const body = rows.map((r) => [
      r.name,
      fmtDate(r.closeDate),
      r.jobTypes.join(" / ") || "—",
      r.cabinet,
      r.countertop,
      r.amount,
      r.contract,
      r.delta,
      [r.cabinetMismatch ? "cabinet amount w/o Reface type" : "", r.countertopMismatch ? "countertop amount w/o Countertops type" : ""]
        .filter(Boolean)
        .join("; "),
    ])
    const csv = [header, ...body].map((r) => r.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = "express-reface-contract-deals-12mo.csv"
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
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
          <CardTitle className="text-base">Express Reface deals — cabinet, countertop &amp; contract</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Closed-won Express Reface deals over the last 12 months, comparing product amounts to the deal &amp;
            contract price
            {loading || !totals ? null : (
              <>
                {" "}
                — {formatNumber(rows.length)} deal{rows.length === 1 ? "" : "s"} · deal {formatCurrency(totals.amount)}{" "}
                vs contract {formatCurrency(totals.contract)}
              </>
            )}
            .
          </p>
          {!loading && mismatchCount > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {formatNumber(mismatchCount)} deal{mismatchCount === 1 ? "" : "s"} have a cabinet or countertop amount
                that doesn&apos;t match the job type (highlighted below). Those amounts are excluded from the totals, so
                cabinet + countertop reconciles against the deal amount.
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
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
        {report.isError || report.data?.error ? (
          <div className="flex items-center gap-3 py-4 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {(report.data?.error as string) || (report.error as Error)?.message || "Failed to load deals."}
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <FileText className="size-4" />
            No closed-won Express Reface deals in the last 12 months.
          </p>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Deal</th>
                  <th className="px-2 py-2 text-right font-medium">Closed date</th>
                  <th className="px-2 py-2 text-left font-medium">Job type(s)</th>
                  <th className="px-2 py-2 text-right font-medium">Cabinet</th>
                  <th className="px-2 py-2 text-right font-medium">Countertop</th>
                  <th className="px-2 py-2 text-right font-medium">Deal amount</th>
                  <th className="px-2 py-2 text-right font-medium">Contract amount</th>
                  <th className="pl-2 py-2 text-right font-medium">Delta (deal − contract)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const flagged = r.cabinetMismatch || r.countertopMismatch
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/50 transition-colors",
                        flagged ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/40",
                      )}
                    >
                      <td className="max-w-[18rem] truncate py-1.5 pr-2" title={r.name}>
                        {flagged && (
                          <AlertTriangle
                            className="mr-1 inline size-3.5 shrink-0 -translate-y-px text-destructive"
                            aria-label="Job type mismatch"
                          />
                        )}
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {fmtDate(r.closeDate)}
                      </td>
                      <td className="px-2 py-1.5 text-left">
                        {r.jobTypes.length ? (
                          <span className="flex flex-wrap gap-1">
                            {r.jobTypes.map((t) => (
                              <span
                                key={t}
                                className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                              >
                                {t}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 text-right tabular-nums",
                          r.cabinetMismatch && "font-semibold text-destructive",
                        )}
                        title={r.cabinetMismatch ? "Cabinet amount present but job type has no Reface" : undefined}
                      >
                        {r.cabinet ? formatCurrency(r.cabinet) : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 text-right tabular-nums",
                          r.countertopMismatch && "font-semibold text-destructive",
                        )}
                        title={
                          r.countertopMismatch ? "Countertop amount present but job type has no Countertops" : undefined
                        }
                      >
                        {r.countertop ? formatCurrency(r.countertop) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(r.amount)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.contract ? formatCurrency(r.contract) : "—"}
                      </td>
                      <td className="pl-2 py-1.5 text-right">
                        <DeltaCell value={r.delta} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 bg-card">
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="py-1.5 pr-2 text-muted-foreground">Total ({formatNumber(rows.length)})</td>
                  <td />
                  <td />
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totals?.cabinet ?? 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totals?.countertop ?? 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totals?.amount ?? 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totals?.contract ?? 0)}</td>
                  <td className="pl-2 py-1.5 text-right">
                    <DeltaCell value={totals?.delta ?? 0} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
