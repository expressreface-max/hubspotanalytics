"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Play, Download, Loader2, Home, User2, MapPin } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Status = { configured: boolean }

type PropertyDetail = {
  yearBuilt: number | null
  propertyType: string | null
  bedrooms: number | null
  bathrooms: number | null
  livingSquareFeet: number | null
  estimatedValue: number | null
  estimatedEquity: number | null
  ownerOccupied: boolean | null
  absenteeOwner: boolean | null
  lastSaleDate: string | null
  lastSalePrice: number | null
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

type CustomerRow = {
  contactId: string
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
  dealAmount: number
  quotedAt: string | null
  closedWon: boolean
  closedAt: string | null
  enrichment: Enrichment | null
}

type CustomerAnalysisResponse = {
  scope: "ever_quoted" | "closed_won"
  rows: CustomerRow[]
  total: number
  totalDealsFetched: number
  missingAddress: number
  reapiConfigured: boolean
  enriched: boolean
}

const SCOPES = [
  { key: "ever_quoted" as const, label: "Ever Quoted" },
  { key: "closed_won" as const, label: "Closed-Won" },
]

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

function fmtDate(iso: string | null): string {
  if (!iso) return "–"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function CustomerAnalysisView() {
  const [scope, setScope] = useState<"ever_quoted" | "closed_won">("ever_quoted")

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const report = useQuery({
    queryKey: ["customer-analysis", scope],
    queryFn: () => apiPost<CustomerAnalysisResponse>("/api/hs/customer-analysis", { scope, limit: 300, enrich: true }),
    enabled: !!connected,
  })

  const data = report.data

  const exportCsv = () => {
    if (!data) return
    const header = [
      "First",
      "Last",
      "Email",
      "Phone",
      "Address",
      "City",
      "State",
      "Zip",
      "Deal Amount",
      "Quoted At",
      "Closed Won",
      "Closed At",
      "Year Built",
      "Estimated Value",
      "Owner Occupied",
      "Owner Age",
      "Owner Marital Status",
      "Owner Occupation",
      "Area Median Income",
    ]
    const lines = [header.join(",")]
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`
    for (const r of data.rows) {
      const p = r.enrichment?.property
      const o = r.enrichment?.owner
      lines.push(
        [
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
          r.closedWon,
          esc(r.closedAt),
          p?.yearBuilt ?? "",
          p?.estimatedValue ?? "",
          p?.ownerOccupied ?? "",
          o?.age ?? "",
          esc(o?.maritalStatus),
          esc(o?.occupation),
          p?.medianIncomeArea ?? "",
        ].join(","),
      )
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `customer-analysis-${scope}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Customer Analysis"
        description="Quoted customers enriched with property and owner-demographic data from RealEstateAPI"
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Scope</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {SCOPES.map((s) => (
              <Pill key={s.key} active={scope === s.key} onClick={() => setScope(s.key)}>
                {s.label}
              </Pill>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => report.refetch()} disabled={report.isFetching} className="gap-1.5">
              {report.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
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
              RealEstateAPI is not configured on this deployment (missing REALESTATEAPI_KEY) — showing HubSpot data
              only, without property or owner enrichment.
            </p>
          ) : null}
          {data ? (
            <p className="text-xs text-muted-foreground">
              Individual income is not available from RealEstateAPI — the Area Median Income column reflects the
              HUD-area median for the property&apos;s ZIP, not the specific owner&apos;s income.
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
            {(report.error as Error)?.message || "Failed to load customer analysis."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {scope === "ever_quoted" ? "Ever-quoted customers" : "Closed-won customers"}
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            {data ? (
              <span className="text-sm text-muted-foreground">
                {formatNumber(data.total)} customers
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
              <p className="py-10 text-center text-sm text-muted-foreground">No customers found for this scope.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="sticky left-0 z-10 min-w-40 bg-card py-2 pr-3 text-left font-medium">Customer</th>
                      <th className="min-w-52 py-2 pr-3 text-left font-medium">Address</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Deal amount</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Quoted</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Year built</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Est. value</th>
                      <th className="py-2 pr-3 text-center font-medium text-muted-foreground">Owner-occ</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Owner age</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Marital / Occupation</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">
                        Area med. income
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const p = r.enrichment?.property
                      const o = r.enrichment?.owner
                      const hasEnrichError = r.enrichment?.propertyError || r.enrichment?.skipTraceError
                      return (
                        <tr key={r.dealId} className="border-b border-border/50 align-top">
                          <td className="sticky left-0 z-10 bg-card py-2 pr-3">
                            <div className="flex items-center gap-1.5 font-medium">
                              <User2 className="size-3.5 text-muted-foreground" />
                              {[r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown"}
                            </div>
                            <div className="text-xs text-muted-foreground">{r.email || r.phone || "—"}</div>
                          </td>
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
                          <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(r.dealAmount)}</td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {fmtDate(r.quotedAt)}
                            {r.closedWon ? (
                              <div className="text-emerald-600 dark:text-emerald-400">Won {fmtDate(r.closedAt)}</div>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{p?.yearBuilt ?? "–"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p?.estimatedValue ? formatCurrency(p.estimatedValue) : "–"}
                          </td>
                          <td className="py-2 pr-3 text-center">
                            {p?.ownerOccupied == null ? (
                              "–"
                            ) : (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                                  p.ownerOccupied
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                <Home className="size-3" />
                                {p.ownerOccupied ? "Yes" : "No"}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{o?.age ?? "–"}</td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {[o?.maritalStatus, o?.occupation].filter(Boolean).join(" · ") ||
                              (hasEnrichError ? "No match" : "–")}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p?.medianIncomeArea ? formatCurrency(p.medianIncomeArea) : "–"}
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
