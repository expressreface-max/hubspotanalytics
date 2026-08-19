"use client"

import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { apiGet, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MeetingsWeeksSection, type MeetingsResponse } from "@/components/meetings-weeks-section"
import { ConsultNoQuoteSection, type ConsultNoQuoteData } from "@/components/consult-no-quote-section"
import { OpenQuotePipelineSection, type QuoteAnalysis } from "@/components/open-quote-pipeline-section"
import { OpenQuotesSection, type OpenQuotesData } from "@/components/open-quotes-section"
import { SalesRepYtdSection, type SalesRepYtdData } from "@/components/sales-rep-ytd-section"
import { cn } from "@/lib/utils"

// One stored row per time window, pre-computed by the nightly job and read
// instantly from the database (no live HubSpot calls on page load).
type MetricRow = {
  periodKey: string
  label: string
  contacts: number
  appointments: number
  quotes: number
  closedWon: number
  wonRevenue: number
}
type StoredMetrics = { rows: MetricRow[]; updatedAt: string | null }

// The three section snapshots, each { payload, updatedAt } | null.
type Snap<T> = { payload: T; updatedAt: string } | null
type SectionsResponse = {
  meetingsWeeks: Snap<MeetingsResponse>
  openQuotePipeline: Snap<QuoteAnalysis>
  salesRepYtd: Snap<SalesRepYtdData>
  consultNoQuote: Snap<ConsultNoQuoteData>
  openQuotesList: Snap<OpenQuotesData>
}

// Column order (matches the nightly job's period order).
const PERIOD_ORDER = ["yesterday", "thisWeek", "lastWeek", "mtd", "lastMonth", "ytd", "lastYearYtd"]

// Matrix rows: the metrics, mapped to stored-row fields.
const METRICS: { key: keyof MetricRow; label: string; currency?: boolean }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "appointments", label: "Appointments" },
  { key: "quotes", label: "Quotes" },
  { key: "closedWon", label: "Closed won" },
  { key: "wonRevenue", label: "Won revenue", currency: true },
]

function fmt(v: number, currency?: boolean) {
  return currency ? formatCurrency(v) : formatNumber(v)
}

export function SalesManagerView() {
  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })
  const configured = !!status.data?.configured

  const metrics = useQuery({
    queryKey: ["sales-manager-metrics"],
    queryFn: () => apiGet<StoredMetrics>("/api/hs/sales-manager"),
    enabled: configured,
  })

  const sections = useQuery({
    queryKey: ["sales-manager-sections"],
    queryFn: () => apiGet<SectionsResponse>("/api/hs/sales-manager/sections"),
    enabled: configured,
    // Snapshot data is seeded/refreshed out-of-band (nightly cron + manual seeds),
    // so always pull fresh on mount — otherwise a tab left open before a reseed
    // keeps showing the pre-seed (empty) result until a hard refresh.
    refetchOnMount: "always",
    staleTime: 0,
  })

  const rowsByKey = new Map((metrics.data?.rows ?? []).map((r) => [r.periodKey, r]))
  const columns = PERIOD_ORDER.map((key) => rowsByKey.get(key)).filter(Boolean) as MetricRow[]
  const loading = metrics.isLoading || (configured && !metrics.data)
  const sectionsLoading = sections.isLoading || (configured && !sections.data)

  if (!status.isLoading && !configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Sales Manager" description="Nightly summary snapshot of key sales metrics." />
        <NotConnected />
      </div>
    )
  }

  // The snapshot timestamp — the whole page reflects a single nightly run.
  const snapUpdatedAt =
    metrics.data?.updatedAt ||
    sections.data?.meetingsWeeks?.updatedAt ||
    sections.data?.salesRepYtd?.updatedAt ||
    null
  const updatedLabel = snapUpdatedAt
    ? new Date(snapUpdatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sales Manager"
        description="A static summary snapshot, recomputed automatically every night at 12:01 AM Pacific."
      />

      {updatedLabel && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Snapshot as of {updatedLabel} · updates automatically overnight
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Performance matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 bg-card px-4 py-3 text-left font-medium text-muted-foreground">
                    Metric
                  </th>
                  {(loading ? PERIOD_ORDER.map(() => null) : columns).map((c, i) => (
                    <th key={c?.periodKey ?? `col-${i}`} className="px-4 py-3 text-right font-semibold">
                      {loading ? (
                        <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" aria-label="Loading" />
                      ) : (
                        c!.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 bg-card px-4 py-3 font-medium">{m.label}</td>
                    {(loading ? PERIOD_ORDER.map(() => null) : columns).map((c, i) => (
                      <td key={c?.periodKey ?? `col-${i}`} className="px-4 py-3 text-right tabular-nums">
                        {loading ? (
                          <Loader2
                            className="ml-auto size-4 animate-spin text-muted-foreground"
                            aria-label="Loading"
                          />
                        ) : (
                          <span className={cn(m.currency && "font-semibold")}>
                            {fmt(c![m.key] as number, m.currency)}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <MeetingsWeeksSection data={sections.data?.meetingsWeeks?.payload ?? null} loading={sectionsLoading} />

      <ConsultNoQuoteSection data={sections.data?.consultNoQuote?.payload ?? null} loading={sectionsLoading} />

      <OpenQuotePipelineSection data={sections.data?.openQuotePipeline?.payload ?? null} loading={sectionsLoading} />

      <OpenQuotesSection data={sections.data?.openQuotesList?.payload ?? null} loading={sectionsLoading} />

      <SalesRepYtdSection data={sections.data?.salesRepYtd?.payload ?? null} loading={sectionsLoading} />
    </div>
  )
}
