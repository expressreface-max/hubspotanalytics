"use client"

import { ArrowUpRight, ArrowDownRight } from "lucide-react"
import { formatCurrency, formatNumber } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// Shared funnel metrics + KPI card components, used by both the Funnel
// (territory) view and the Sales Rep view so the two stay visually identical.
export type Metrics = {
  contactsCreated: number
  created: number
  apptSet: number
  quoted: number
  closedWon: number
  revenue: number
}

export type KpiStat = { label: string; value: string }

// Percentage of num over den, rendered as a rounded "%" (em dash when no base).
export function pct(num: number, den: number): string {
  if (!den) return "—"
  return `${Math.round((num / den) * 100)}%`
}

// Percentage delta between a current and a previous value. Null when no baseline.
export function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null
  return (current - previous) / previous
}

// Small colored chip showing the period-over-period delta (green up / red down).
export function DeltaChip({ pct: value }: { pct: number }) {
  const up = value >= 0
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        up ? "bg-chart-3/15 text-chart-3" : "bg-destructive/15 text-destructive",
      )}
      title="Change vs compare period"
    >
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {up ? "+" : ""}
      {Math.round(value * 100)}%
    </span>
  )
}

// One column of a KPI card: period label, headline value, and stacked sub-stats.
function KpiColumn({
  periodLabel,
  value,
  stats,
  loading,
  muted,
}: {
  periodLabel?: string
  value: string
  stats: KpiStat[]
  loading?: boolean
  muted?: boolean
}) {
  return (
    <div className="min-w-0">
      {periodLabel ? (
        <div
          className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          title={periodLabel}
        >
          {periodLabel}
        </div>
      ) : null}
      {loading ? (
        <Skeleton className="mt-1 h-7 w-20" />
      ) : (
        <div className={cn("num mt-0.5 text-2xl font-bold", muted && "text-muted-foreground")}>{value}</div>
      )}
      {stats.length ? (
        <div className="mt-3 space-y-1 text-xs">
          {stats.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-2">
              <span className="truncate text-muted-foreground">{s.label}</span>
              <span className={cn("num shrink-0", muted && "text-muted-foreground")}>{loading ? "—" : s.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// Rich KPI card. Single-column by default; when `compare` is provided the card is
// split vertically to show the reference period next to the compare period.
export function FunnelKpi({
  label,
  value,
  stats,
  loading,
  compare,
  delta,
  primaryLabel,
}: {
  label: string
  value: string
  stats: KpiStat[]
  loading?: boolean
  compare?: { value: string; stats: KpiStat[]; loading?: boolean; periodLabel?: string }
  delta?: number | null
  primaryLabel?: string
}) {
  if (!compare) {
    return (
      <Card className="p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-24" />
        ) : (
          <div className="num mt-1 text-3xl font-bold">{value}</div>
        )}
        {stats.length ? (
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {stats.map((s) => (
              <div key={s.label} className="contents">
                <span className="text-muted-foreground">{s.label}</span>
                <span className="num text-right">{loading ? "—" : s.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        {delta != null && !loading && !compare.loading ? <DeltaChip pct={delta} /> : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <KpiColumn periodLabel={primaryLabel} value={value} stats={stats} loading={loading} />
        <div className="border-l border-border pl-3">
          <KpiColumn
            periodLabel={compare.periodLabel}
            value={compare.value}
            stats={compare.stats}
            loading={compare.loading}
            muted
          />
        </div>
      </div>
    </Card>
  )
}

// Zero baseline used while data loads so KPI descriptors can compute safely.
export const ZERO_METRICS: Metrics = {
  contactsCreated: 0,
  created: 0,
  apptSet: 0,
  quoted: 0,
  closedWon: 0,
  revenue: 0,
}

// Declarative KPI descriptors: one place to derive the headline value, the
// stacked sub-stats, and the raw number (for deltas) from a Metrics object.
export const KPI_CONFIG: {
  label: string
  raw: (m: Metrics) => number
  main: (m: Metrics) => string
  stats: (m: Metrics) => KpiStat[]
}[] = [
  {
    label: "Contacts",
    raw: (m) => m.contactsCreated,
    main: (m) => formatNumber(m.contactsCreated),
    stats: () => [],
  },
  {
    label: "Deals created",
    raw: (m) => m.created,
    main: (m) => formatNumber(m.created),
    stats: (m) => [{ label: "% of contacts", value: pct(m.created, m.contactsCreated) }],
  },
  {
    label: "Appt set",
    raw: (m) => m.apptSet,
    main: (m) => formatNumber(m.apptSet),
    stats: (m) => [
      { label: "% of contacts", value: pct(m.apptSet, m.contactsCreated) },
      { label: "% of deals", value: pct(m.apptSet, m.created) },
    ],
  },
  {
    label: "Quoted",
    raw: (m) => m.quoted,
    main: (m) => formatNumber(m.quoted),
    stats: (m) => [
      { label: "% of contacts", value: pct(m.quoted, m.contactsCreated) },
      { label: "% of deals", value: pct(m.quoted, m.created) },
      { label: "% of appt", value: pct(m.quoted, m.apptSet) },
    ],
  },
  {
    label: "Closed won",
    raw: (m) => m.closedWon,
    main: (m) => formatNumber(m.closedWon),
    stats: (m) => [
      { label: "% of contacts", value: pct(m.closedWon, m.contactsCreated) },
      { label: "% of deals", value: pct(m.closedWon, m.created) },
      { label: "% of appt", value: pct(m.closedWon, m.apptSet) },
      { label: "% of quoted", value: pct(m.closedWon, m.quoted) },
    ],
  },
  {
    label: "Won revenue",
    raw: (m) => m.revenue,
    main: (m) => formatCurrency(m.revenue),
    stats: (m) => [
      { label: "avg per closed won", value: formatCurrency(m.revenue / Math.max(1, m.closedWon)) },
      { label: "per contact", value: formatCurrency(m.revenue / Math.max(1, m.contactsCreated)) },
      { label: "per deal", value: formatCurrency(m.revenue / Math.max(1, m.created)) },
      { label: "per appt", value: formatCurrency(m.revenue / Math.max(1, m.apptSet)) },
    ],
  },
]
