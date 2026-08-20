"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Play, Download, X, MapPin, Loader2 } from "lucide-react"
import { apiGet, apiPost, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Status = { configured: boolean }

type CrosstabRow = { zip: string; territory: string; counts: Record<string, number>; total: number }
type CrosstabResponse = {
  source: string
  months: string[]
  lookback: number
  zips: string[]
  zipTerritory: Record<string, string>
  rows: CrosstabRow[]
  columnTotals: Record<string, number>
  grandTotal: number
  matched: number
  totalFetched: number
}

const LOOKBACKS = [
  { key: 1, label: "1 month" },
  { key: 3, label: "3 months" },
  { key: 6, label: "6 months" },
  { key: 12, label: "12 months" },
  { key: 24, label: "24 months" },
] as const

function monthShort(m: string) {
  const [y, mo] = m.split("-")
  return new Date(Number(y), Number(mo) - 1, 1)
    .toLocaleDateString("en-US", { month: "short", year: "2-digit" })
    .replace(" ", " '")
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

// Parse a free-form string into unique, valid 5-digit zips (first-seen order).
function parseZips(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw.split(/[\s,;]+/)) {
    const m = token.trim().match(/^\d{5}/)
    if (m && !seen.has(m[0])) {
      seen.add(m[0])
      out.push(m[0])
    }
  }
  return out
}

export function ContactsView() {
  const [zipText, setZipText] = useState("")
  const [months, setMonths] = useState<number>(12)
  // The applied query params (set when the user runs the report).
  const [applied, setApplied] = useState<{ zips: string[]; months: number } | null>(null)

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const parsedZips = useMemo(() => parseZips(zipText), [zipText])

  const report = useQuery({
    queryKey: ["contacts-by-zip", applied?.zips, applied?.months],
    queryFn: () => apiPost<CrosstabResponse>("/api/hs/contacts-by-zip", applied),
    enabled: !!connected && !!applied && applied.zips.length > 0,
  })

  const runReport = () => {
    if (parsedZips.length === 0) return
    setApplied({ zips: parsedZips, months })
  }

  const data = report.data

  const exportCsv = () => {
    if (!data) return
    const header = ["ZIP", "Territory", ...data.months.map(monthShort), "Total"]
    const lines = [header.join(",")]
    for (const r of data.rows) {
      lines.push(
        [r.zip, `"${(r.territory || "").replace(/"/g, '""')}"`, ...data.months.map((m) => r.counts[m] ?? 0), r.total].join(
          ",",
        ),
      )
    }
    lines.push(["Total", "", ...data.months.map((m) => data.columnTotals[m] ?? 0), data.grandTotal].join(","))
    const blob = new Blob([lines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `contacts-by-zip-${data.lookback}mo.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Contacts"
        description="Contacts created per ZIP code by month · HubSpot crosstab"
      />

      {/* Controls: ZIP prompt + lookback */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Report settings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="zip-input">ZIP codes to include</Label>
            <textarea
              id="zip-input"
              value={zipText}
              onChange={(e) => setZipText(e.target.value)}
              placeholder="Enter 5-digit ZIPs separated by commas, spaces, or new lines&#10;e.g. 95660, 95821, 95608"
              rows={3}
              className={cn(
                "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none",
                "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
              )}
            />
            {parsedZips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs text-muted-foreground">
                  {parsedZips.length} ZIP{parsedZips.length === 1 ? "" : "s"}:
                </span>
                {parsedZips.map((z) => (
                  <span
                    key={z}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium tabular-nums"
                  >
                    <MapPin className="size-3 text-muted-foreground" />
                    {z}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setZipText("")}
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                  Clear
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Multiple ZIPs supported. Invalid entries are ignored.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Lookback</Label>
            <div className="flex flex-wrap items-center gap-2">
              {LOOKBACKS.map((l) => (
                <Pill key={l.key} active={months === l.key} onClick={() => setMonths(l.key)}>
                  {l.label}
                </Pill>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={runReport} disabled={parsedZips.length === 0 || report.isFetching} className="gap-1.5">
              {report.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {report.isFetching ? "Running…" : "Run report"}
            </Button>
            {data ? (
              <Button variant="outline" onClick={exportCsv} className="gap-1.5 bg-transparent">
                <Download className="size-4" />
                Export CSV
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {!connected ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Connect HubSpot in Settings to run this report.
          </CardContent>
        </Card>
      ) : report.isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {(report.error as Error)?.message || "Failed to load contacts."}
          </CardContent>
        </Card>
      ) : !applied ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Enter ZIP codes and a lookback window, then run the report.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Contacts created by ZIP · trailing {applied.months} month{applied.months === 1 ? "" : "s"}
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            {data ? (
              <span className="text-sm text-muted-foreground">{formatNumber(data.grandTotal)} contacts</span>
            ) : null}
          </CardHeader>
          <CardContent>
            {report.isFetching || !data ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="sticky left-0 z-10 bg-card py-2 pr-3 text-left font-medium">ZIP</th>
                      <th className="py-2 pr-3 text-left font-medium">Territory</th>
                      {data.months.map((m) => (
                        <th key={m} className="px-2 py-2 text-right font-medium tabular-nums text-muted-foreground">
                          {monthShort(m)}
                        </th>
                      ))}
                      <th className="px-2 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.zip} className="border-b border-border/50">
                        <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 font-medium tabular-nums">{r.zip}</td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 text-left",
                            r.territory ? "" : "text-muted-foreground/40",
                          )}
                        >
                          {r.territory || "–"}
                        </td>
                        {data.months.map((m) => {
                          const v = r.counts[m] ?? 0
                          return (
                            <td
                              key={m}
                              className={cn(
                                "px-2 py-1.5 text-right tabular-nums",
                                v === 0 ? "text-muted-foreground/40" : "",
                              )}
                            >
                              {v === 0 ? "–" : formatNumber(v)}
                            </td>
                          )
                        })}
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{formatNumber(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="sticky left-0 z-10 bg-card py-2 pr-3">Total</td>
                      <td className="py-2 pr-3" />
                      {data.months.map((m) => (
                        <td key={m} className="px-2 py-2 text-right tabular-nums">
                          {formatNumber(data.columnTotals[m] ?? 0)}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(data.grandTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
