"use client"

import { useQuery } from "@tanstack/react-query"
import { Download, Loader2, RefreshCw, MapPin } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Status = { configured: boolean }

type PropertyDetail = {
  yearBuilt: number | null
  estimatedValue: number | null
  ownerOccupied: boolean | null
  medianIncomeArea: number | null
}

type SkipTraceOwner = {
  fullName: string | null
  age: number | null
  maritalStatus: string | null
  occupation: string | null
}

type Enrichment = {
  property: PropertyDetail | null
  owner: SkipTraceOwner | null
  propertyError: string | null
  skipTraceError: string | null
}

type DealStatus = "closed_won" | "closed_lost" | "open"

type DealByStageRow = {
  dealId: string
  dealName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  pipeline: string | null
  stageLabel: string | null
  dealStatus: DealStatus
  dealAmount: number
  quotedAt: string | null
  closedAt: string | null
  territory: string | null
  enrichment: Enrichment | null
}

type DealsByStageResponse = {
  rows: DealByStageRow[]
  total: number
  totalDealsFetched: number
  missingAddress: number
  reapiConfigured: boolean
  enriched: boolean
}

const STATUS_LABEL: Record<DealStatus, string> = {
  open: "Open",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
}

const STATUS_STYLE: Record<DealStatus, string> = {
  open: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  closed_won: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  closed_lost: "bg-muted text-muted-foreground",
}

function fmtDate(iso: string | null): string {
  if (!iso) return "–"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function DealsByStageView() {
  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const report = useQuery({
    queryKey: ["deals-by-stage"],
    queryFn: () => apiPost<DealsByStageResponse>("/api/hs/deals-by-stage", { limit: 300, enrich: true }),
    enabled: !!connected,
  })

  const data = report.data

  const exportCsv = () => {
    if (!data) return
    const header = [
      "Deal",
      "First",
      "Last",
      "Email",
      "Phone",
      "Address",
      "City",
      "State",
      "Zip",
      "Deal Amount",
      "Quote Date",
      "Deal Status",
      "Stage",
      "Closed At",
      "Territory",
      "Year Built",
      "Estimated Value",
      "Owner Occupied",
      "Owner Age",
      "Area Median Income",
    ]
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const lines = [header.join(",")]
    for (const r of data.rows) {
      const p = r.enrichment?.property
      const o = r.enrichment?.owner
      lines.push(
        [
          esc(r.dealName),
          esc(r.firstName),
          esc(r.lastName),
          esc(r.email),
          esc(r.phone),
          esc(r.address),
          esc(r.city),
          esc(r.state),
          esc(r.zip),
          r.dealAmount,
          esc(r.quotedAt),
          esc(STATUS_LABEL[r.dealStatus]),
          esc(r.stageLabel),
          esc(r.closedAt),
          esc(r.territory),
          p?.yearBuilt ?? "",
          p?.estimatedValue ?? "",
          p?.ownerOccupied ?? "",
          o?.age ?? "",
          p?.medianIncomeArea ?? "",
        ].join(","),
      )
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "deals-by-stage.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Deals by Stage"
        description="Every quoted deal, newest quote date first — then deal status, property year built, territory, and owner age"
      />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <div className="flex items-center gap-2">
            <Button onClick={() => report.refetch()} disabled={report.isFetching} className="gap-1.5">
              {report.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {report.isFetching ? "Loading…" : "Refresh"}
            </Button>
            {data ? (
              <Button variant="outline" onClick={exportCsv} className="gap-1.5 bg-transparent">
                <Download className="size-4" />
                Export CSV
              </Button>
            ) : null}
          </div>
          {data && !data.reapiConfigured ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              RealEstateAPI is not configured on this deployment (missing REALESTATEAPI_KEY) — year built, estimated
              value, and owner age will be blank.
            </p>
          ) : null}
          {data ? (
            <p className="text-xs text-muted-foreground">
              Sort order: quote date (newest first) → deal status → property year built → territory → owner age.
              Individual owner income isn&apos;t available from RealEstateAPI — Area Median Income is the HUD-area
              estimate for the property&apos;s ZIP.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {!connected ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Connect HubSpot in Settings to run this report.
          </CardContent>
        </Card>
      ) : report.isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {(report.error as Error)?.message || "Failed to load deals by stage."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Quoted deals
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            {data ? (
              <span className="text-sm text-muted-foreground">
                {formatNumber(data.total)} deals
                {data.missingAddress ? ` · ${formatNumber(data.missingAddress)} missing address` : ""}
              </span>
            ) : null}
          </CardHeader>
          <CardContent>
            {report.isFetching || !data ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No quoted deals found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="sticky left-0 z-10 min-w-40 bg-card py-2 pr-3 text-left font-medium">Deal / Customer</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Quote date</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Deal status</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Amount</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Year built</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Territory</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Owner age</th>
                      <th className="min-w-52 py-2 pr-3 text-left font-medium text-muted-foreground">Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const p = r.enrichment?.property
                      const o = r.enrichment?.owner
                      return (
                        <tr key={r.dealId} className="border-b border-border/50 align-top">
                          <td className="sticky left-0 z-10 bg-card py-2 pr-3">
                            <div className="font-medium">{r.dealName || "Unnamed deal"}</div>
                            <div className="text-xs text-muted-foreground">
                              {[r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown"}
                              {r.stageLabel ? ` · ${r.stageLabel}` : ""}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">{fmtDate(r.quotedAt)}</td>
                          <td className="py-2 pr-3">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                                STATUS_STYLE[r.dealStatus],
                              )}
                            >
                              {STATUS_LABEL[r.dealStatus]}
                            </span>
                            {r.dealStatus !== "open" ? (
                              <div className="mt-0.5 text-xs text-muted-foreground">{fmtDate(r.closedAt)}</div>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(r.dealAmount)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{p?.yearBuilt ?? "–"}</td>
                          <td className="py-2 pr-3 text-xs">{r.territory || "–"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{o?.age ?? "–"}</td>
                          <td className="py-2 pr-3">
                            {r.address ? (
                              <div className="flex items-start gap-1.5">
                                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                <span>
                                  {r.address}
                                  <br />
                                  <span className="text-xs text-muted-foreground">
                                    {r.city}, {r.state} {r.zip}
                                  </span>
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground/60">No address on file</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
